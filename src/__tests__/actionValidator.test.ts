/**
 * Action Validator Tests
 * Tests for validateActionAndCheckProgress function
 */

import { describe, it, expect } from 'vitest';
import { validateActionAndCheckProgress } from '../services/actionValidator';
import type { ExpectedAction, ComputerAction } from '../types';

describe('validateActionAndCheckProgress', () => {
  describe('Action Type Mismatch Detection', () => {
    it('should not advance index when screenshot action is executed for click expected action', () => {
      const expectedActions: ExpectedAction[] = [
        {
          description: '再生ボタンを押す',
          keywords: ['再生', 'ボタン', 'press', 'play'],
          targetElements: ['再生ボタン'],
          expectedToolAction: 'left_click',
          completed: false,
        },
      ];

      const toolAction: ComputerAction = {
        action: 'screenshot',
      };

      // Claude responded mentioning the keywords
      const claudeResponseContext = '再生ボタンを探しています。画面を確認します。';

      const result = validateActionAndCheckProgress(
        toolAction,
        expectedActions,
        0,
        claudeResponseContext,
        false // no screen change
      );

      // Even with keyword matches, screenshot should NOT complete a click action
      expect(result.shouldAdvanceIndex).toBe(false);
      expect(result.confidence).toBe('low');
      // When actual action is non-progressive (screenshot), don't require screen change
      // This prevents lowMediumConfidenceCount from incrementing for observation actions
      expect(result.requiresScreenChange).toBe(false);
      expect(result.reason).toContain('Action type mismatch');
    });

    it('should not advance index when wait action is executed for click expected action', () => {
      const expectedActions: ExpectedAction[] = [
        {
          description: 'ボタンをクリック',
          keywords: ['ボタン', 'クリック'],
          targetElements: ['ボタン'],
          expectedToolAction: 'left_click',
          completed: false,
        },
      ];

      const toolAction: ComputerAction = {
        action: 'wait',
        duration: 1000,
      };

      const result = validateActionAndCheckProgress(
        toolAction,
        expectedActions,
        0,
        'ボタンをクリックするために待機中',
        false
      );

      expect(result.shouldAdvanceIndex).toBe(false);
      expect(result.confidence).toBe('low');
    });

    it('should advance index when left_click action matches left_click expected action with screen change', () => {
      const expectedActions: ExpectedAction[] = [
        {
          description: 'ボタンをクリック',
          keywords: ['ボタン', 'クリック'],
          targetElements: ['ボタン'],
          expectedToolAction: 'left_click',
          completed: false,
        },
      ];

      const toolAction: ComputerAction = {
        action: 'left_click',
        coordinate: [100, 100],
      };

      const result = validateActionAndCheckProgress(
        toolAction,
        expectedActions,
        0,
        'ボタンをクリックします',
        true // screen changed
      );

      // left_click should match left_click expected action
      expect(result.shouldAdvanceIndex).toBe(true);
      expect(result.confidence).toBe('high');
    });

    it('should advance index when screenshot action matches screenshot expected action (no screen change needed)', () => {
      const expectedActions: ExpectedAction[] = [
        {
          description: 'スクリーンショットを撮る',
          keywords: ['スクリーンショット', 'screenshot'],
          targetElements: [],
          expectedToolAction: 'screenshot',
          completed: false,
        },
      ];

      const toolAction: ComputerAction = {
        action: 'screenshot',
      };

      const result = validateActionAndCheckProgress(
        toolAction,
        expectedActions,
        0,
        'スクリーンショットを撮影します',
        false
      );

      // screenshot should match screenshot expected action
      // Non-progressive action doesn't require screen change
      expect(result.shouldAdvanceIndex).toBe(true);
      expect(result.confidence).toBe('high');
    });
  });

  describe('Keyword Matching with Action Type', () => {
    it('should require action type match for high confidence when expectedToolAction is set', () => {
      const expectedActions: ExpectedAction[] = [
        {
          description: 'テキストを入力',
          keywords: ['input', 'text', 'テキスト', '入力'],
          targetElements: ['入力フィールド'],
          expectedToolAction: 'type',
          completed: false,
        },
      ];

      const toolAction: ComputerAction = {
        action: 'screenshot',
      };

      // Even with multiple keyword matches
      const result = validateActionAndCheckProgress(
        toolAction,
        expectedActions,
        0,
        'テキストを入力するために画面を確認します',
        false
      );

      // Should NOT be high confidence due to type mismatch
      expect(result.shouldAdvanceIndex).toBe(false);
      expect(result.confidence).toBe('low');
    });

    it('should return medium confidence when keywords match but expectedToolAction is not set', () => {
      const expectedActions: ExpectedAction[] = [
        {
          description: '何かをする',
          keywords: ['アクション', 'テスト'],
          targetElements: [],
          expectedToolAction: undefined,
          completed: false,
        },
      ];

      const toolAction: ComputerAction = {
        action: 'screenshot',
      };

      const result = validateActionAndCheckProgress(
        toolAction,
        expectedActions,
        0,
        'アクションのテストを行います',
        false
      );

      // Without expectedToolAction, can't detect mismatch
      // But keyword match should give medium confidence
      expect(result.confidence).toBe('medium');
      expect(result.shouldAdvanceIndex).toBe(false);
      // Since actual action is non-progressive (screenshot), don't require screen change
      // This prevents false action_mismatch when the agent takes observation actions
      expect(result.requiresScreenChange).toBe(false);
    });
  });

  describe('requiresScreenChange based on expected action', () => {
    it('should set requiresScreenChange=false when actual action is non-progressive (prevents false action_mismatch)', () => {
      const expectedActions: ExpectedAction[] = [
        {
          description: 'クリック',
          keywords: ['クリック'],
          targetElements: [],
          expectedToolAction: 'left_click',
          completed: false,
        },
      ];

      const toolAction: ComputerAction = {
        action: 'screenshot',
      };

      const result = validateActionAndCheckProgress(
        toolAction,
        expectedActions,
        0,
        undefined,
        false
      );

      // When actual action is non-progressive (screenshot/wait), don't require screen change
      // This prevents lowMediumConfidenceCount from incrementing for observation actions
      expect(result.requiresScreenChange).toBe(false);
    });

    it('should set requiresScreenChange=false for screenshot expected action', () => {
      const expectedActions: ExpectedAction[] = [
        {
          description: 'スクリーンショット',
          keywords: ['スクリーンショット'],
          targetElements: [],
          expectedToolAction: 'screenshot',
          completed: false,
        },
      ];

      const toolAction: ComputerAction = {
        action: 'screenshot',
      };

      const result = validateActionAndCheckProgress(
        toolAction,
        expectedActions,
        0,
        'スクリーンショットを撮影',
        false
      );

      // screenshot expected action doesn't require screen change
      expect(result.requiresScreenChange).toBe(false);
    });
  });

  describe('Reverse Mismatch Detection (non-progressive expected + click actual)', () => {
    it('should not advance index when click action is executed for screenshot expected action', () => {
      const expectedActions: ExpectedAction[] = [
        {
          description: 'スクリーンショットを撮る',
          keywords: ['スクリーンショット', 'capture', '撮影'],
          targetElements: [],
          expectedToolAction: 'screenshot',
          completed: false,
        },
      ];

      const toolAction: ComputerAction = {
        action: 'left_click',
        coordinate: [100, 100],
      };

      const result = validateActionAndCheckProgress(
        toolAction,
        expectedActions,
        0,
        'スクリーンショットを撮影するためにクリックします',
        true // screen changed
      );

      // Even with keyword match and screen change, click should NOT complete screenshot expected action
      expect(result.shouldAdvanceIndex).toBe(false);
      expect(result.confidence).toBe('low');
    });

    it('should not advance index when click action is executed for wait expected action', () => {
      const expectedActions: ExpectedAction[] = [
        {
          description: '3秒待つ',
          keywords: ['待つ', 'wait', '秒'],
          targetElements: [],
          expectedToolAction: 'wait',
          completed: false,
        },
      ];

      const toolAction: ComputerAction = {
        action: 'left_click',
        coordinate: [100, 100],
      };

      const result = validateActionAndCheckProgress(
        toolAction,
        expectedActions,
        0,
        '3秒待ってからクリック',
        true
      );

      expect(result.shouldAdvanceIndex).toBe(false);
      expect(result.confidence).toBe('low');
    });
  });

  describe('Same Action Type Should Not Mismatch', () => {
    it('should advance index when mouse_move action matches mouse_move expected action', () => {
      const expectedActions: ExpectedAction[] = [
        {
          description: 'マウスを移動',
          keywords: ['移動', 'mouse', 'move'],
          targetElements: [],
          expectedToolAction: 'mouse_move',
          completed: false,
        },
      ];

      const toolAction: ComputerAction = {
        action: 'mouse_move',
        coordinate: [200, 200],
      };

      const result = validateActionAndCheckProgress(
        toolAction,
        expectedActions,
        0,
        'マウスを移動させます',
        false
      );

      // mouse_move should match mouse_move expected action (non-progressive, no screen change needed)
      expect(result.shouldAdvanceIndex).toBe(true);
      expect(result.confidence).toBe('high');
    });
  });

  describe('Type/Key Action Mismatch Detection', () => {
    it('should not advance index when wait action is executed for type expected action', () => {
      const expectedActions: ExpectedAction[] = [
        {
          description: 'テキストを入力する',
          keywords: ['入力', 'type', 'テキスト'],
          targetElements: ['入力フィールド'],
          expectedToolAction: 'type',
          completed: false,
        },
      ];

      const toolAction: ComputerAction = {
        action: 'wait',
        duration: 1000,
      };

      const result = validateActionAndCheckProgress(
        toolAction,
        expectedActions,
        0,
        'テキストを入力する前に待機',
        false
      );

      expect(result.shouldAdvanceIndex).toBe(false);
      expect(result.confidence).toBe('low');
    });

    it('should not advance index when scroll action is executed for type expected action', () => {
      const expectedActions: ExpectedAction[] = [
        {
          description: 'テキストを入力',
          keywords: ['入力', 'テキスト'],
          targetElements: [],
          expectedToolAction: 'type',
          completed: false,
        },
      ];

      const toolAction: ComputerAction = {
        action: 'scroll',
        coordinate: [100, 100],
        scroll_direction: 'down',
        scroll_amount: 100,
      };

      const result = validateActionAndCheckProgress(
        toolAction,
        expectedActions,
        0,
        '入力フィールドを探すためにスクロール',
        true
      );

      expect(result.shouldAdvanceIndex).toBe(false);
      expect(result.confidence).toBe('low');
    });

    it('should not advance index when screenshot action is executed for key expected action', () => {
      const expectedActions: ExpectedAction[] = [
        {
          description: 'Enterキーを押す',
          keywords: ['Enter', 'キー', '押す'],
          targetElements: [],
          expectedToolAction: 'key',
          completed: false,
        },
      ];

      const toolAction: ComputerAction = {
        action: 'screenshot',
      };

      const result = validateActionAndCheckProgress(
        toolAction,
        expectedActions,
        0,
        'Enterキーを押す前に画面確認',
        false
      );

      expect(result.shouldAdvanceIndex).toBe(false);
      expect(result.confidence).toBe('low');
    });
  });
});
