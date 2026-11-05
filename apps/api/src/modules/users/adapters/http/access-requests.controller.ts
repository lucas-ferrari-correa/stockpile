import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBadRequestResponse, ApiBody, ApiForbiddenResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AccessRequestResponse } from '@stockpile/shared';
import { ZodResponse } from 'nestjs-zod';
import { Public } from '../../../auth/adapters/http/auth.decorators';
import { AuthErrorDto } from '../../../auth/adapters/http/auth.dto';
import { AccessRequestsService } from '../../application/access-requests.service';
import { AccessRequestDto, AccessRequestResponseDto } from './users.dto';

@ApiTags('auth')
@Controller('auth')
export class AccessRequestsController {
  constructor(private readonly accessRequests: AccessRequestsService) {}

  @Public()
  @Post('access-requests')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Request access to the application',
    description:
      'New, pending or active emails answer 202 with the same generic message. Blocked, rejected and deleted accounts answer the same 403; a deleted account also becomes a re-registration request without a role.',
  })
  @ApiBody({
    type: AccessRequestDto,
    examples: { newUser: { value: { name: 'Jane Doe', email: 'jane@example.com', password: 'a-strong-password' } } },
  })
  @ZodResponse({ status: 202, description: 'Request received', type: AccessRequestResponseDto })
  @ApiBadRequestResponse({ description: 'Malformed request body' })
  @ApiForbiddenResponse({
    description: 'The account is blocked, rejected or deleted; a deleted account is turned into a re-registration request',
    type: AuthErrorDto.Output,
    example: {
      statusCode: 403,
      code: 'ACCOUNT_UNAVAILABLE',
      message:
        'This account does not have access. It may have been blocked, rejected or deleted. If it was deleted, a re-registration request has been sent to the administrator.',
    },
  })
  request(@Body() body: AccessRequestDto): Promise<AccessRequestResponse> {
    return this.accessRequests.request(body);
  }
}
