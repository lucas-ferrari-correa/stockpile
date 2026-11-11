import { Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, Query, Req } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiConsumes,
  ApiNotFoundResponse,
  ApiOperation,
  ApiPayloadTooLargeResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuthUser, IMPORT_FILE_FIELD, ImportAccepted, ImportDetail } from '@stockpile/shared';
import { Request } from 'express';
import { ZodResponse } from 'nestjs-zod';
import { AppConfigService } from '../../../../infra/config/app-config.service';
import { CurrentUser, RequirePermissions } from '../../../auth/adapters/http/auth.decorators';
import { AuthErrorDto } from '../../../auth/adapters/http/auth.dto';
import { ImportsService } from '../../application/imports.service';
import { FILE_STORAGE, FileStorage } from '../../ports/file-storage';
import { receiveCsvUpload } from './csv-upload';
import {
  DuplicateImportErrorDto,
  ImportAcceptedDto,
  ImportDetailDto,
  ImportErrorDto,
  ImportIdParamDto,
  ImportUploadQueryDto,
  RatesUnavailableErrorDto,
} from './imports.dto';

@ApiTags('imports')
@RequirePermissions('imports:manage')
@ApiUnauthorizedResponse({
  description: 'Missing, invalid or expired token, or the user is no longer active',
  type: AuthErrorDto.Output,
  example: { statusCode: 401, code: 'UNAUTHENTICATED', message: 'Authentication is required' },
})
@Controller('imports')
export class ImportsController {
  constructor(
    private readonly imports: ImportsService,
    private readonly config: AppConfigService,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
  ) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Upload an inventory CSV and start its import',
    description:
      'The file is streamed to temporary storage while its SHA-256 is computed. A file whose content matches an import that is pending, processing or completed (by any user) is rejected with 409 DUPLICATE_IMPORT unless force=true is sent; failed imports never block. Duplicates are also enforced by the database, so concurrent identical uploads resolve to one import and 409 for the others. Then the exchange rates are captured for the import and a background job is enqueued. When the rates cannot be captured the import is kept as failed and the request answers 503 RATES_UNAVAILABLE with its importId. When the job cannot be enqueued the import stays pending, the request still answers 202 and the worker enqueues it later.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: [IMPORT_FILE_FIELD],
      properties: { [IMPORT_FILE_FIELD]: { type: 'string', format: 'binary', description: 'CSV file with the .csv extension' } },
    },
  })
  @ZodResponse({ status: 202, description: 'Import accepted', type: ImportAcceptedDto })
  @ApiBadRequestResponse({
    description: 'Missing file field, file without the .csv extension, malformed multipart body or invalid force flag',
    type: ImportErrorDto.Output,
    example: { statusCode: 400, code: 'INVALID_FILE_TYPE', message: 'Only files with the .csv extension are accepted' },
  })
  @ApiConflictResponse({
    description:
      'A file with the same content was already imported (pending, processing or completed, by any user). Send force=true to import it again.',
    type: DuplicateImportErrorDto.Output,
    example: {
      statusCode: 409,
      code: 'DUPLICATE_IMPORT',
      message: 'This file was already imported',
      existingImportId: '7b9c2f4e-1d3a-4c5b-8e6f-0a1b2c3d4e5f',
    },
  })
  @ApiPayloadTooLargeResponse({
    description: 'The file exceeds the configured upload limit',
    type: ImportErrorDto.Output,
    example: { statusCode: 413, code: 'FILE_TOO_LARGE', message: 'The uploaded file exceeds the maximum allowed size' },
  })
  @ApiServiceUnavailableResponse({
    description: 'The exchange rates could not be captured; the import was created and marked as failed',
    type: RatesUnavailableErrorDto.Output,
    example: {
      statusCode: 503,
      code: 'RATES_UNAVAILABLE',
      message: 'The exchange rates could not be captured, the import was marked as failed',
      importId: '7b9c2f4e-1d3a-4c5b-8e6f-0a1b2c3d4e5f',
    },
  })
  async create(
    @Req() request: Request,
    @Query() query: ImportUploadQueryDto,
    @CurrentUser() user: AuthUser,
  ): Promise<ImportAccepted> {
    const upload = await receiveCsvUpload(request, this.storage, this.config.get('UPLOAD_MAX_BYTES'));
    return this.imports.create(user, upload, { force: query.force });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Return the status, progress, counters and exchange rate snapshot of an import' })
  @ZodResponse({ status: 200, description: 'Import status', type: ImportDetailDto })
  @ApiBadRequestResponse({ description: 'The id is not a valid UUID' })
  @ApiNotFoundResponse({
    description: 'No import with this id',
    type: ImportErrorDto.Output,
    example: { statusCode: 404, code: 'IMPORT_NOT_FOUND', message: 'Import not found' },
  })
  findOne(@Param() params: ImportIdParamDto): Promise<ImportDetail> {
    return this.imports.find(params.id);
  }
}
