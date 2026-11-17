import { ApiQuery } from '@nestjs/swagger';
import { LISTING_SEARCH_MAX_LENGTH } from '@stockpile/shared';

export function ApiSearchQuery(description: string, examples: Record<string, string>): MethodDecorator {
  return ApiQuery({
    name: 'q',
    required: false,
    schema: { type: 'string', maxLength: LISTING_SEARCH_MAX_LENGTH },
    description,
    examples: Object.fromEntries(
      Object.entries({ 'no search': '', ...examples }).map(([summary, value]) => [summary, { summary, value }]),
    ),
  });
}
