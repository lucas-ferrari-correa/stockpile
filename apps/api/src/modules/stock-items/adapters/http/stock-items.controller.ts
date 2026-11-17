import { Controller, Get, HttpStatus, Query, Req, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { stockItemPageSchema } from '@stockpile/shared';
import { Request, Response } from 'express';
import { ETAG_RESPONSE_HEADERS, negotiateEtag } from '../../../../infra/http/listing-etag';
import { ApiSearchQuery } from '../../../../infra/http/search-query-docs';
import { AuthErrorDto } from '../../../auth/adapters/http/auth.dto';
import { ImportErrorDto } from '../../../imports/adapters/http/imports.dto';
import { StockItemsService } from '../../application/stock-items.service';
import { StockItemPageDto, StockItemsErrorDto, StockItemsQueryDto } from './stock-items.dto';

const STOCK_ITEMS_ROUTE = 'GET /stock-items';

@ApiTags('stock-items')
@ApiBearerAuth()
@ApiUnauthorizedResponse({
  description: 'Missing, invalid or expired token, or the user is no longer active',
  type: AuthErrorDto.Output,
  example: { statusCode: 401, code: 'UNAUTHENTICATED', message: 'Authentication is required' },
})
@ApiForbiddenResponse({
  description: 'The account has been blocked',
  type: AuthErrorDto.Output,
  example: { statusCode: 403, code: 'ACCOUNT_BLOCKED', message: 'Your account has been blocked' },
})
@Controller('stock-items')
export class StockItemsController {
  constructor(private readonly stockItems: StockItemsService) {}

  @Get()
  @ApiOperation({
    summary: 'List stock items with filters, search, sorting and keyset pagination',
    description: [
      'The catalog is shared by every active user. With importId the listing covers the items that currently belong to that import and is available only once the import has completed. Without importId it covers the whole catalog.',
      'category, brand, supplier, country and warehouse accept several values by repeating the parameter, for example category=Dairy&category=Bakery. minPrice, maxPrice, minCost and maxCost are inclusive USD amounts with up to 2 decimals, for example 12.50; amounts in the response are integer cents. minQuantity and maxQuantity are inclusive. expiresFrom and expiresTo are inclusive YYYY-MM-DD dates; expiration=none keeps only items without expiration. createdFrom and createdTo are inclusive YYYY-MM-DD days, in the IANA time zone tz, of the creation of the import of each item.',
      'Items without expiration are always listed last when sorting by expiration. Pagination is keyset based: pass nextCursor back as cursor with the same sort and order. total is the number of matching items on the first page and null on pages requested with a cursor.',
      'Conversions use the exchange rate snapshot captured for the import of each item, in integer cents of the target currency rounded half-up.',
      'Every response carries a strong ETag that changes with the query and with the catalog (or the import, with importId); sending it back in If-None-Match returns 304 without a body.',
    ].join('\n\n'),
  })
  @ApiHeader({ name: 'If-None-Match', required: false, description: 'ETag of a previous response for the same query' })
  @ApiSearchQuery(
    'General search. Matches items whose sku, name, brand, supplier or lot contains the term (case-insensitive), whose unit price or unit cost equals an amount such as 12.50, or whose expiration matches a date such as 10/27/2026, 10/27 (any year) or 10/2026 (whole month).',
    { name: 'yogurt', amount: '12.50', day: '10/27/2026', 'day in any year': '10/27', month: '10/2026' },
  )
  @ApiOkResponse({ description: 'One page of stock items', type: StockItemPageDto.Output, headers: ETAG_RESPONSE_HEADERS })
  @ApiResponse({
    status: HttpStatus.NOT_MODIFIED,
    description: 'If-None-Match matches the current ETag; no body',
    headers: ETAG_RESPONSE_HEADERS,
  })
  @ApiBadRequestResponse({
    description: 'Invalid query parameters, or a cursor that is malformed, does not match sort and order, or points to no item',
    type: StockItemsErrorDto.Output,
    example: {
      statusCode: 400,
      code: 'INVALID_CURSOR',
      message: 'The cursor is malformed or does not match the requested sort and order',
    },
  })
  @ApiNotFoundResponse({
    description: 'No import with this id',
    type: ImportErrorDto.Output,
    example: { statusCode: 404, code: 'IMPORT_NOT_FOUND', message: 'Import not found' },
  })
  @ApiConflictResponse({
    description: 'The import exists but has not completed (pending, processing or failed)',
    type: StockItemsErrorDto.Output,
    example: { statusCode: 409, code: 'IMPORT_NOT_COMPLETED', message: 'The import has not completed yet' },
  })
  async list(@Query() query: StockItemsQueryDto, @Req() request: Request, @Res() response: Response): Promise<void> {
    const listing = await this.stockItems.prepare(query);

    const outcome = negotiateEtag(request, response, {
      route: STOCK_ITEMS_ROUTE,
      version: this.stockItems.version(listing.scope),
      query: listing.query,
    });
    if (outcome.kind === 'not-modified') {
      return;
    }

    const page = await this.stockItems.list(listing);
    response.status(HttpStatus.OK).json(stockItemPageSchema.parse(page));
  }
}
