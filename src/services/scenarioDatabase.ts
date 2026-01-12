/**
 * Scenario Database Service - SQLite operations for scenario management
 */

import Database from '@tauri-apps/plugin-sql';
import type { StoredScenario, StepImage } from '../types';

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
 * Uses transaction to ensure atomic updates
 */
export async function updateScenarioOrders(
  orders: { id: string; orderIndex: number }[]
): Promise<void> {
  if (orders.length === 0) return;

  const database = await getDatabase();

  // Use transaction for atomic update
  await database.execute('BEGIN TRANSACTION');
  try {
    for (const order of orders) {
      await database.execute(
        'UPDATE scenarios SET order_index = ?, updated_at = datetime("now") WHERE id = ?',
        [order.orderIndex, order.id]
      );
    }
    await database.execute('COMMIT');
  } catch (error) {
    await database.execute('ROLLBACK');
    throw error;
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

// ============================================================
// Step Image CRUD Operations
// ============================================================

/**
 * Add an image to a test step
 * @param scenarioId Scenario ID
 * @param base64Data Raw Base64 data (without data: prefix)
 * @param fileName File name
 * @param mimeType MIME type
 */
export async function addStepImage(
  scenarioId: string,
  base64Data: string,
  fileName: string,
  mimeType: string = 'image/png'
): Promise<StepImage> {
  const database = await getDatabase();
  const id = crypto.randomUUID();

  // Get the next order_index for this scenario
  const maxOrder = await database.select<[{ max_order: number | null }]>(
    'SELECT MAX(order_index) as max_order FROM step_images WHERE scenario_id = ?',
    [scenarioId]
  );
  const orderIndex = (maxOrder[0]?.max_order ?? -1) + 1;

  await database.execute(
    'INSERT INTO step_images (id, scenario_id, image_data, file_name, mime_type, order_index) VALUES (?, ?, ?, ?, ?, ?)',
    [id, scenarioId, base64Data, fileName, mimeType, orderIndex]
  );

  return {
    id,
    scenario_id: scenarioId,
    image_data: base64Data,
    file_name: fileName,
    mime_type: mimeType,
    order_index: orderIndex,
    created_at: new Date().toISOString(),
  };
}

/**
 * Get all images for a test step
 */
export async function getStepImages(scenarioId: string): Promise<StepImage[]> {
  const database = await getDatabase();
  return database.select<StepImage[]>(
    'SELECT * FROM step_images WHERE scenario_id = ? ORDER BY order_index ASC',
    [scenarioId]
  );
}

/**
 * Delete a single image by ID
 */
export async function deleteStepImage(imageId: string): Promise<void> {
  const database = await getDatabase();
  await database.execute('DELETE FROM step_images WHERE id = ?', [imageId]);
}

/**
 * Delete all images for a test step
 * Note: This is automatically handled by ON DELETE CASCADE when scenario is deleted
 */
export async function deleteAllStepImages(scenarioId: string): Promise<void> {
  const database = await getDatabase();
  await database.execute('DELETE FROM step_images WHERE scenario_id = ?', [
    scenarioId,
  ]);
}

/**
 * Update image orders for a scenario
 */
export async function updateStepImageOrders(
  orders: { id: string; orderIndex: number }[]
): Promise<void> {
  if (orders.length === 0) return;

  const database = await getDatabase();

  await database.execute('BEGIN TRANSACTION');
  try {
    for (const order of orders) {
      await database.execute(
        'UPDATE step_images SET order_index = ? WHERE id = ?',
        [order.orderIndex, order.id]
      );
    }
    await database.execute('COMMIT');
  } catch (error) {
    await database.execute('ROLLBACK');
    throw error;
  }
}
