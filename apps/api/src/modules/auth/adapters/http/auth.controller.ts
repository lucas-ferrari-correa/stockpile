import { Body, Controller, Get, HttpCode, HttpStatus, Patch, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuthUser, LoginResponse } from '@stockpile/shared';
import { ZodResponse } from 'nestjs-zod';
import { AuthService } from '../../application/auth.service';
import { CurrentUser, Public } from './auth.decorators';
import {
  AuthErrorDto,
  ChangePasswordRequestDto,
  LoginRequestDto,
  LoginResponseDto,
  MeResponseDto,
  UpdateProfileRequestDto,
} from './auth.dto';
import { RateLimit } from './rate-limit.decorator';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @RateLimit('login')
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

  @Patch('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update the display name of the authenticated user; other fields are ignored' })
  @ApiBody({ type: UpdateProfileRequestDto, examples: { rename: { value: { name: 'Stock Keeper' } } } })
  @ZodResponse({ status: 200, description: 'Updated current user', type: MeResponseDto })
  @ApiBadRequestResponse({ description: 'Name is missing, blank or longer than allowed' })
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
  updateProfile(@CurrentUser() user: AuthUser, @Body() body: UpdateProfileRequestDto): Promise<AuthUser> {
    return this.auth.updateProfile(user, body.name);
  }

  @Post('me/password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Change the password of the authenticated user and revoke previously issued tokens' })
  @ApiBody({
    type: ChangePasswordRequestDto,
    examples: { change: { value: { currentPassword: 'your-password', newPassword: 'a-new-strong-password' } } },
  })
  @ApiNoContentResponse({ description: 'Password changed; tokens issued before this request are no longer valid' })
  @ApiBadRequestResponse({ description: 'Current password missing or new password outside the allowed length' })
  @ApiUnauthorizedResponse({
    description: 'Missing, invalid or expired token, or the user is no longer active',
    type: AuthErrorDto.Output,
    example: { statusCode: 401, code: 'UNAUTHENTICATED', message: 'Authentication is required' },
  })
  @ApiForbiddenResponse({
    description: 'The current password is incorrect, or the account was blocked after the token was issued',
    type: AuthErrorDto.Output,
    example: { statusCode: 403, code: 'CURRENT_PASSWORD_INVALID', message: 'The current password is incorrect' },
  })
  async changePassword(@CurrentUser() user: AuthUser, @Body() body: ChangePasswordRequestDto): Promise<void> {
    await this.auth.changePassword(user.id, body.currentPassword, body.newPassword);
  }
}
