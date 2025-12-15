#!/usr/bin/env bash

set -e

export NODE_OPTIONS='--max-old-space-size=1536'

echo "Building Mastra..."
mastra build

echo "Copying static files..."
# Copy public files to .mastra output directory
if [ -d ".mastra/output" ]; then
  mkdir -p .mastra/output/public
  cp -r src/mastra/public/* .mastra/output/public/
  echo "Static files copied to .mastra/output/public/"
fi

# Also copy to root public for fallback
mkdir -p public
cp -r src/mastra/public/* public/
echo "Static files copied to public/"

echo "Build complete!"
