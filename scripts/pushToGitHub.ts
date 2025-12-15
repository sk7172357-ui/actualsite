import { Octokit } from "@octokit/rest";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

const REPO_NAME = "biletiks-mastra";
const REPO_DESCRIPTION = "Ticket booking platform built with Mastra framework";
const SOURCE_DIR = "./github-export";

async function getAccessToken(): Promise<string> {
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  
  const stdout = execSync('replit identity create --audience "https://' + hostname + '"', { encoding: 'utf8' });
  const replitToken = stdout.trim();
  
  if (!replitToken) {
    throw new Error("Replit Identity Token not found");
  }
  
  const res = await fetch(
    `https://${hostname}/api/v2/connection?include_secrets=true&connector_names=github`,
    {
      headers: {
        Accept: "application/json",
        "Replit-Authentication": `Bearer ${replitToken}`,
      },
    }
  );
  
  const data = await res.json() as any;
  const connectionSettings = data.items?.[0];
  const accessToken = connectionSettings?.settings?.access_token || 
                      connectionSettings?.settings?.oauth?.credentials?.access_token;
  
  if (!accessToken) {
    throw new Error("GitHub not connected");
  }
  
  return accessToken;
}

function getAllFiles(dir: string, baseDir: string = dir): { path: string; content: string }[] {
  const files: { path: string; content: string }[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(baseDir, fullPath);
    
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      files.push(...getAllFiles(fullPath, baseDir));
    } else {
      const content = fs.readFileSync(fullPath);
      files.push({
        path: relativePath,
        content: content.toString("base64"),
      });
    }
  }
  
  return files;
}

async function main() {
  console.log("Getting GitHub access token...");
  const accessToken = await getAccessToken();
  
  const octokit = new Octokit({ auth: accessToken });
  
  const { data: user } = await octokit.users.getAuthenticated();
  console.log(`Authenticated as: ${user.login}`);
  
  let repoExists = false;
  let hasCommits = false;
  
  try {
    const { data: repo } = await octokit.repos.get({ owner: user.login, repo: REPO_NAME });
    repoExists = true;
    console.log(`Repository ${REPO_NAME} already exists`);
    
    try {
      await octokit.repos.listCommits({ owner: user.login, repo: REPO_NAME, per_page: 1 });
      hasCommits = true;
    } catch {
      hasCommits = false;
    }
  } catch {
    console.log(`Creating repository ${REPO_NAME}...`);
  }
  
  if (!repoExists) {
    await octokit.repos.createForAuthenticatedUser({
      name: REPO_NAME,
      description: REPO_DESCRIPTION,
      private: true,
      auto_init: true,
    });
    console.log(`Repository ${REPO_NAME} created with initial commit!`);
    
    await new Promise(resolve => setTimeout(resolve, 2000));
    hasCommits = true;
  } else if (!hasCommits) {
    await octokit.repos.createOrUpdateFileContents({
      owner: user.login,
      repo: REPO_NAME,
      path: ".gitkeep",
      message: "Initialize repository",
      content: Buffer.from("").toString("base64"),
    });
    console.log("Initialized empty repository");
    await new Promise(resolve => setTimeout(resolve, 2000));
    hasCommits = true;
  }
  
  console.log("Reading files from github-export...");
  const files = getAllFiles(SOURCE_DIR);
  console.log(`Found ${files.length} files`);
  
  console.log("Creating blobs...");
  const blobs = await Promise.all(
    files.map(async (file) => {
      const { data } = await octokit.git.createBlob({
        owner: user.login,
        repo: REPO_NAME,
        content: file.content,
        encoding: "base64",
      });
      return { path: file.path, sha: data.sha, mode: "100644" as const, type: "blob" as const };
    })
  );
  
  const { data: ref } = await octokit.git.getRef({
    owner: user.login,
    repo: REPO_NAME,
    ref: "heads/main",
  });
  const baseCommitSha = ref.object.sha;
  
  console.log("Creating tree...");
  const { data: tree } = await octokit.git.createTree({
    owner: user.login,
    repo: REPO_NAME,
    tree: blobs,
    base_tree: baseCommitSha,
  });
  
  console.log("Creating commit...");
  const { data: commit } = await octokit.git.createCommit({
    owner: user.login,
    repo: REPO_NAME,
    message: "Portable version of BILETIKS platform for external deployment",
    tree: tree.sha,
    parents: [baseCommitSha],
  });
  
  console.log("Updating branch...");
  await octokit.git.updateRef({
    owner: user.login,
    repo: REPO_NAME,
    ref: "heads/main",
    sha: commit.sha,
  });
  
  console.log(`\nSuccess! Repository pushed to: https://github.com/${user.login}/${REPO_NAME}`);
}

main().catch(console.error);
