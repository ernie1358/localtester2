/**
 * Scenario Database Service - SQLite operations for scenario management
 */

import Database from '@tauri-apps/plugin-sql';
import type { StoredScenario } from '../types';

let db: Database | null = null;

/**
 * Get or create database connection
 */
export async function getDatabase(): Promise<Database> {
  if (!db) {
    db = await Database.load('sqlite:xenotester.db');
  }
  return db;
}

/**
 * Get all scenarios ordered by order_index
 */
export async function getAllScenarios(): Promise<StoredScenario[]> {
  const database = await getDatabase();
  return database.select<StoredScenario[]>(
    'SELECT * FROM scenarios ORDER BY order_index ASC'
  );
}

/**
 * Generate title from description (first 30 chars of first line)
 */
function generateTitleFromDescription(description: string): string {
  const firstLine = description.split('\n')[0].trim();
  if (firstLine.length <= 30) {
    return firstLine || 'シナリオ';
  }
  return firstLine.substring(0, 30) + '...';
}

/**
 * Create a new scenario
 */
export async function createScenario(
  title: string,
  description: string
): Promise<StoredScenario> {
  const database = await getDatabase();
  const id = crypto.randomUUID();

  // Get the next order_index
  const maxOrder = await database.select<[{ max_order: number | null }]>(
    'SELECT MAX(order_index) as max_order FROM scenarios'
  );
  const orderIndex = (maxOrder[0]?.max_order ?? -1) + 1;

  // Auto-generate title if empty
  const finalTitle = title.trim() || generateTitleFromDescription(description);

  await database.execute(
    'INSERT INTO scenarios (id, title, description, order_index) VALUES (?, ?, ?, ?)',
    [id, finalTitle, description, orderIndex]
  );

  return {
    id,
    title: finalTitle,
    description,
    order_index: orderIndex,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

/**
 * Update an existing scenario
 */
export async function updateScenario(
  id: string,
  title: string,
  description: string
): Promise<void> {
  const database = await getDatabase();

  // Auto-generate title if empty
  const finalTitle = title.trim() || generateTitleFromDescription(description);

  await database.execute(
    'UPDATE scenarios SET title = ?, description = ?, updated_at = datetime("now") WHERE id = ?',
    [finalTitle, description, id]
  );
}

/**
 * Delete a scenario
 */
export async function deleteScenario(id: string): Promise<void> {
  const database = await getDatabase();
  await database.execute('DELETE FROM scenarios WHERE id = ?', [id]);
}

/**
 * Update scenario orders (for drag & drop reordering)
 */
export async function updateScenarioOrders(
  orders: { id: string; orderIndex: number }[]
): Promise<void> {
  const database = await getDatabase();
  for (const order of orders) {
    await database.execute(
      'UPDATE scenarios SET order_index = ?, updated_at = datetime("now") WHERE id = ?',
      [order.orderIndex, order.id]
    );
  }
}

/**
 * Get a single scenario by ID
 */
export async function getScenarioById(
  id: string
): Promise<StoredScenario | null> {
  const database = await getDatabase();
  const results = await database.select<StoredScenario[]>(
    'SELECT * FROM scenarios WHERE id = ?',
    [id]
  );
  return results[0] || null;
}
