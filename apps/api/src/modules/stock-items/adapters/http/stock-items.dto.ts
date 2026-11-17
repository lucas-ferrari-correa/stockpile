import { stockItemPageSchema, stockItemsErrorSchema, stockItemsQuerySchema } from '@stockpile/shared';
import { createZodDto } from 'nestjs-zod';

export class StockItemsQueryDto extends createZodDto(stockItemsQuerySchema) {}

export class StockItemPageDto extends createZodDto(stockItemPageSchema) {}

export class StockItemsErrorDto extends createZodDto(stockItemsErrorSchema) {}
