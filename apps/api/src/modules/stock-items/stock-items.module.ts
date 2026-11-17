import { Module } from '@nestjs/common';
import { StockItemsController } from './adapters/http/stock-items.controller';
import { StockItemsService } from './application/stock-items.service';

@Module({
  controllers: [StockItemsController],
  providers: [StockItemsService],
})
export class StockItemsModule {}
