/**
 * Scenario Database Service Tests
 * Tests CRUD operations and order management for scenarios
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock Tauri SQL plugin
const mockSelect = vi.fn();
const mockExecute = vi.fn();

vi.mock('@tauri-apps/plugin-sql', () => ({
  default: {
    load: vi.fn().mockResolvedValue({
      select: mockSelect,
      execute: mockExecute,
    }),
  },
}));

// Mock crypto.randomUUID
const mockUUID = '12345678-1234-1234-1234-123456789abc';
vi.stubGlobal('crypto', {
  randomUUID: vi.fn(() => mockUUID),
});

describe('Scenario Database Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetModules();
  });

  describe('getAllScenarios', () => {
    it('should return all scenarios ordered by order_index', async () => {
      const mockScenarios = [
        { id: '1', title: 'First', description: 'desc1', order_index: 0, created_at: '2024-01-01', updated_at: '2024-01-01' },
        { id: '2', title: 'Second', description: 'desc2', order_index: 1, created_at: '2024-01-02', updated_at: '2024-01-02' },
      ];
      mockSelect.mockResolvedValueOnce(mockScenarios);

      const { getAllScenarios } = await import('../services/scenarioDatabase');
      const result = await getAllScenarios();

      expect(mockSelect).toHaveBeenCalledWith('SELECT * FROM scenarios ORDER BY order_index ASC');
      expect(result).toEqual(mockScenarios);
    });

    it('should return empty array when no scenarios exist', async () => {
      mockSelect.mockResolvedValueOnce([]);

      const { getAllScenarios } = await import('../services/scenarioDatabase');
      const result = await getAllScenarios();

      expect(result).toEqual([]);
    });
  });

  describe('createScenario', () => {
    it('should create a scenario with provided title', async () => {
      mockSelect.mockResolvedValueOnce([{ max_order: 2 }]); // For max order query
      mockExecute.mockResolvedValueOnce(undefined);

      const { createScenario } = await import('../services/scenarioDatabase');
      const result = await createScenario('Test Title', 'Test Description');

      expect(mockExecute).toHaveBeenCalledWith(
        'INSERT INTO scenarios (id, title, description, order_index) VALUES (?, ?, ?, ?)',
        [mockUUID, 'Test Title', 'Test Description', 3]
      );
      expect(result.id).toBe(mockUUID);
      expect(result.title).toBe('Test Title');
      expect(result.description).toBe('Test Description');
      expect(result.order_index).toBe(3);
    });

    it('should auto-generate title from description when title is empty', async () => {
      mockSelect.mockResolvedValueOnce([{ max_order: null }]);
      mockExecute.mockResolvedValueOnce(undefined);

      const { createScenario } = await import('../services/scenarioDatabase');
      const result = await createScenario('', 'This is the first line of description\nSecond line');

      // Title is truncated at 30 chars + '...'
      // 'This is the first line of desc' = 30 chars
      expect(mockExecute).toHaveBeenCalledWith(
        'INSERT INTO scenarios (id, title, description, order_index) VALUES (?, ?, ?, ?)',
        [mockUUID, 'This is the first line of desc...', 'This is the first line of description\nSecond line', 0]
      );
      expect(result.title).toBe('This is the first line of desc...');
    });

    it('should truncate auto-generated title at 30 characters with ellipsis', async () => {
      mockSelect.mockResolvedValueOnce([{ max_order: null }]);
      mockExecute.mockResolvedValueOnce(undefined);

      const { createScenario } = await import('../services/scenarioDatabase');
      const longDescription = 'This is a very long description that should be truncated';
      await createScenario('', longDescription);

      // Verify the first line is truncated to 30 chars + '...'
      const insertCall = mockExecute.mock.calls[0];
      expect(insertCall[1][1]).toBe('This is a very long descriptio...');
    });

    it('should not add ellipsis for short descriptions', async () => {
      mockSelect.mockResolvedValueOnce([{ max_order: null }]);
      mockExecute.mockResolvedValueOnce(undefined);

      const { createScenario } = await import('../services/scenarioDatabase');
      const result = await createScenario('', 'Short title');

      expect(result.title).toBe('Short title');
    });
  });

  describe('updateScenario', () => {
    it('should update scenario with provided title', async () => {
      mockExecute.mockResolvedValueOnce(undefined);

      const { updateScenario } = await import('../services/scenarioDatabase');
      await updateScenario('test-id', 'Updated Title', 'Updated Description');

      expect(mockExecute).toHaveBeenCalledWith(
        'UPDATE scenarios SET title = ?, description = ?, updated_at = datetime("now") WHERE id = ?',
        ['Updated Title', 'Updated Description', 'test-id']
      );
    });

    it('should auto-generate title when empty', async () => {
      mockExecute.mockResolvedValueOnce(undefined);

      const { updateScenario } = await import('../services/scenarioDatabase');
      await updateScenario('test-id', '', 'New description content');

      expect(mockExecute).toHaveBeenCalledWith(
        'UPDATE scenarios SET title = ?, description = ?, updated_at = datetime("now") WHERE id = ?',
        ['New description content', 'New description content', 'test-id']
      );
    });
  });

  describe('deleteScenario', () => {
    it('should delete scenario by id', async () => {
      mockExecute.mockResolvedValueOnce(undefined);

      const { deleteScenario } = await import('../services/scenarioDatabase');
      await deleteScenario('test-id');

      expect(mockExecute).toHaveBeenCalledWith(
        'DELETE FROM scenarios WHERE id = ?',
        ['test-id']
      );
    });
  });

  describe('updateScenarioOrders', () => {
    it('should update order_index for multiple scenarios', async () => {
      mockExecute
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined);

      const { updateScenarioOrders } = await import('../services/scenarioDatabase');
      await updateScenarioOrders([
        { id: 'a', orderIndex: 2 },
        { id: 'b', orderIndex: 0 },
        { id: 'c', orderIndex: 1 },
      ]);

      expect(mockExecute).toHaveBeenCalledTimes(3);
      expect(mockExecute).toHaveBeenNthCalledWith(
        1,
        'UPDATE scenarios SET order_index = ?, updated_at = datetime("now") WHERE id = ?',
        [2, 'a']
      );
      expect(mockExecute).toHaveBeenNthCalledWith(
        2,
        'UPDATE scenarios SET order_index = ?, updated_at = datetime("now") WHERE id = ?',
        [0, 'b']
      );
      expect(mockExecute).toHaveBeenNthCalledWith(
        3,
        'UPDATE scenarios SET order_index = ?, updated_at = datetime("now") WHERE id = ?',
        [1, 'c']
      );
    });

    it('should handle empty orders array', async () => {
      const { updateScenarioOrders } = await import('../services/scenarioDatabase');
      await updateScenarioOrders([]);

      expect(mockExecute).not.toHaveBeenCalled();
    });
  });

  describe('getScenarioById', () => {
    it('should return scenario when found', async () => {
      const mockScenario = { id: 'test-id', title: 'Test', description: 'Desc', order_index: 0, created_at: '2024-01-01', updated_at: '2024-01-01' };
      mockSelect.mockResolvedValueOnce([mockScenario]);

      const { getScenarioById } = await import('../services/scenarioDatabase');
      const result = await getScenarioById('test-id');

      expect(mockSelect).toHaveBeenCalledWith(
        'SELECT * FROM scenarios WHERE id = ?',
        ['test-id']
      );
      expect(result).toEqual(mockScenario);
    });

    it('should return null when not found', async () => {
      mockSelect.mockResolvedValueOnce([]);

      const { getScenarioById } = await import('../services/scenarioDatabase');
      const result = await getScenarioById('nonexistent-id');

      expect(result).toBeNull();
    });
  });
});
