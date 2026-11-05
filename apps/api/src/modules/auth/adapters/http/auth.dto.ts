import { authErrorSchema, loginRequestSchema, loginResponseSchema, meResponseSchema } from '@stockpile/shared';
import { createZodDto } from 'nestjs-zod';

export class LoginRequestDto extends createZodDto(loginRequestSchema) {}

export class LoginResponseDto extends createZodDto(loginResponseSchema) {}

export class MeResponseDto extends createZodDto(meResponseSchema) {}

export class AuthErrorDto extends createZodDto(authErrorSchema) {}
