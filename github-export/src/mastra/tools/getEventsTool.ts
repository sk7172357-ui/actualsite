import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import pg from "pg";

const { Pool } = pg;

let pool: pg.Pool | null = null;

function getPool(): pg.Pool | null {
  if (pool) return pool;
  
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.warn("[getEventsTool] DATABASE_URL not set");
    return null;
  }
  
  try {
    pool = new Pool({ connectionString: dbUrl });
    return pool;
  } catch (error) {
    console.error("[getEventsTool] Failed to create pool:", error);
    return null;
  }
}

export const getEventsTool = createTool({
  id: "get-events",
  description:
    "Get available events, categories, and cities. Use this tool when the user wants to see available events, browse by category or city, or needs information about what's available.",

  inputSchema: z.object({
    categoryId: z
      .number()
      .optional()
      .describe("Filter by category ID (optional)"),
    cityId: z.number().optional().describe("Filter by city ID (optional)"),
    eventId: z
      .number()
      .optional()
      .describe("Get specific event by ID (optional)"),
    includeCategories: z
      .boolean()
      .optional()
      .describe("Include list of all categories"),
    includeCities: z.boolean().optional().describe("Include list of all cities"),
  }),

  outputSchema: z.object({
    events: z.array(
      z.object({
        id: z.number(),
        name: z.string(),
        description: z.string().nullable(),
        categoryName: z.string(),
        cityName: z.string(),
        date: z.string().nullable(),
        time: z.string().nullable(),
        price: z.number(),
        availableSeats: z.number(),
      }),
    ),
    categories: z
      .array(
        z.object({
          id: z.number(),
          name: z.string(),
          nameRu: z.string(),
        }),
      )
      .optional(),
    cities: z
      .array(
        z.object({
          id: z.number(),
          name: z.string(),
        }),
      )
      .optional(),
  }),

  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("🔧 [getEventsTool] Starting execution with params:", context);

    const dbPool = getPool();
    
    if (!dbPool) {
      logger?.warn("⚠️ [getEventsTool] Database not available, returning empty data");
      return { events: [], categories: [], cities: [] };
    }

    try {
      let eventsQuery = `
        SELECT 
          e.id, 
          e.name, 
          e.description, 
          c.name_ru as category_name, 
          ci.name as city_name,
          e.date::text,
          e.time::text,
          e.price::numeric as price,
          e.available_seats
        FROM events e
        JOIN categories c ON e.category_id = c.id
        JOIN cities ci ON e.city_id = ci.id
        WHERE e.available_seats > 0
      `;
      const params: any[] = [];
      let paramIndex = 1;

      if (context.eventId) {
        eventsQuery += ` AND e.id = $${paramIndex}`;
        params.push(context.eventId);
        paramIndex++;
      }
      if (context.categoryId) {
        eventsQuery += ` AND e.category_id = $${paramIndex}`;
        params.push(context.categoryId);
        paramIndex++;
      }
      if (context.cityId) {
        eventsQuery += ` AND e.city_id = $${paramIndex}`;
        params.push(context.cityId);
        paramIndex++;
      }

      eventsQuery += " ORDER BY e.date ASC";

      logger?.info("📝 [getEventsTool] Executing events query...");
      const eventsResult = await dbPool.query(eventsQuery, params);

      const events = eventsResult.rows.map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        categoryName: row.category_name,
        cityName: row.city_name,
        date: row.date,
        time: row.time,
        price: parseFloat(row.price) || 0,
        availableSeats: row.available_seats,
      }));

      let categories;
      if (context.includeCategories) {
        logger?.info("📝 [getEventsTool] Fetching categories...");
        const catResult = await dbPool.query(
          "SELECT id, name, name_ru FROM categories ORDER BY name_ru",
        );
        categories = catResult.rows.map((row) => ({
          id: row.id,
          name: row.name,
          nameRu: row.name_ru,
        }));
      }

      let cities;
      if (context.includeCities) {
        logger?.info("📝 [getEventsTool] Fetching cities...");
        const cityResult = await dbPool.query(
          "SELECT id, name FROM cities ORDER BY name",
        );
        cities = cityResult.rows.map((row) => ({
          id: row.id,
          name: row.name,
        }));
      }

      logger?.info(
        `✅ [getEventsTool] Found ${events.length} events`,
      );

      return { events, categories, cities };
    } catch (error) {
      logger?.error("❌ [getEventsTool] Error:", error);
      return { events: [], categories: [], cities: [] };
    }
  },
});
