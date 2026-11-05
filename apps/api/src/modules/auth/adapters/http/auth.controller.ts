import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiForbiddenResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuthUser, LoginResponse } from '@stockpile/shared';
import { ZodResponse } from 'nestjs-zod';
import { AuthService } from '../../application/auth.service';
import { CurrentUser, Public } from './auth.decorators';
import { AuthErrorDto, LoginRequestDto, LoginResponseDto, MeResponseDto } from './auth.dto';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Exchange email and password for a bearer access token' })
  @ApiBody({
    type: LoginRequestDto,
    examples: { admin: { value: { email: 'admin@stockpile.local', password: 'your-password' } } },
  })
  @ZodResponse({ status: 200, description: 'Authenticated', type: LoginResponseDto })
  @ApiBadRequestResponse({ description: 'Malformed request body' })
  @ApiUnauthorizedResponse({
    description: 'Unknown email, wrong password or account not allowed to sign in',
    type: AuthErrorDto.Output,
    example: { statusCode: 401, code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' },
  })
  @ApiForbiddenResponse({
    description: 'Valid credentials but the account is pending approval or blocked',
    type: AuthErrorDto.Output,
    example: { statusCode: 403, code: 'ACCOUNT_PENDING', message: 'Your account is awaiting approval by an administrator' },
  })
  login(@Body() body: LoginRequestDto): Promise<LoginResponse> {
    return this.auth.login(body.email, body.password);
  }

  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Return the authenticated user with role and effective permissions' })
  @ZodResponse({ status: 200, description: 'Current user', type: MeResponseDto })
  @ApiUnauthorizedResponse({
    description: 'Missing, invalid or expired token, or the user is no longer active',
    type: AuthErrorDto.Output,
    example: { statusCode: 401, code: 'UNAUTHENTICATED', message: 'Authentication is required' },
  })
  @ApiForbiddenResponse({
    description: 'The account was blocked after the token was issued',
    type: AuthErrorDto.Output,
    example: { statusCode: 403, code: 'ACCOUNT_BLOCKED', message: 'Your account has been blocked' },
  })
  me(@CurrentUser() user: AuthUser): AuthUser {
    return user;
  }
}
