import { healthStatusSchema } from '@stockpile/shared';
import { createZodDto } from 'nestjs-zod';

export class HealthStatusDto extends createZodDto(healthStatusSchema) {}
