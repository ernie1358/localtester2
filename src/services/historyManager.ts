/**
 * History Manager - Manage conversation history with token optimization
 */

import type {
  BetaMessageParam,
  BetaContentBlockParam,
} from '@anthropic-ai/sdk/resources/beta/messages';

/**
 * Purge old images from conversation history to save tokens
 * Keeps text content and replaces images with placeholder text
 *
 * @param messages Conversation history
 * @param keepRecentTurns Number of recent turns to keep images for
 * @returns Purged messages array
 */
export function purgeOldImages(
  messages: BetaMessageParam[],
  keepRecentTurns: number = 20
): BetaMessageParam[] {
  // Calculate index from which to start keeping images
  // Each turn consists of user + assistant messages
  const keepFromIndex = Math.max(0, messages.length - keepRecentTurns * 2);

  return messages.map((msg, index) => {
    // Keep recent messages and assistant messages unchanged
    if (index >= keepFromIndex || msg.role !== 'user') {
      return msg;
    }

    // Process user messages - remove images from tool_results
    if (!Array.isArray(msg.content)) {
      return msg;
    }

    const purgedContent: BetaContentBlockParam[] = msg.content.map((block) => {
      // Only process tool_result blocks
      if (block.type !== 'tool_result') {
        return block;
      }

      // Process tool_result content
      if (!Array.isArray(block.content)) {
        return block;
      }

      // Check if there's an image to remove
      const hasImage = block.content.some((item) => item.type === 'image');

      if (!hasImage) {
        return block;
      }

      // Filter out images and add placeholder text
      const filteredContent = block.content.filter(
        (item) => item.type !== 'image'
      );

      return {
        ...block,
        content: [
          ...filteredContent,
          { type: 'text' as const, text: '[screenshot removed to save tokens]' },
        ],
      };
    });

    return { ...msg, content: purgedContent };
  });
}

/**
 * Calculate approximate token count for messages
 * This is a rough estimate (actual count depends on tokenizer)
 */
export function estimateTokenCount(messages: BetaMessageParam[]): number {
  let count = 0;

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      // Rough estimate: 4 characters per token
      count += Math.ceil(msg.content.length / 4);
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if ('text' in block && typeof block.text === 'string') {
          count += Math.ceil(block.text.length / 4);
        }
        if (block.type === 'image') {
          // Images are counted by size, rough estimate
          count += 1000; // Base cost for image processing
        }
        if (block.type === 'tool_result' && Array.isArray(block.content)) {
          for (const item of block.content) {
            if ('text' in item && typeof item.text === 'string') {
              count += Math.ceil(item.text.length / 4);
            }
            if (item.type === 'image') {
              count += 1000;
            }
          }
        }
      }
    }
  }

  return count;
}
