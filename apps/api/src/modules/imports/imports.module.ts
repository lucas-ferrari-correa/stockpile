import { Module } from '@nestjs/common';
import { ExchangeRatesModule } from '../exchange-rates/exchange-rates.module';
import { ImportsController } from './adapters/http/imports.controller';
import { fileStorageProvider } from './adapters/storage/local-file-storage';
import { ImportsService } from './application/imports.service';
import { ImportQueueModule } from './import-queue.module';

@Module({
  imports: [ImportQueueModule, ExchangeRatesModule],
  controllers: [ImportsController],
  providers: [ImportsService, fileStorageProvider],
})
export class ImportsModule {}
