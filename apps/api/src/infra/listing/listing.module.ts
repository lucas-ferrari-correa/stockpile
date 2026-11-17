import { Global, Module } from '@nestjs/common';
import { ListingService } from './listing';

@Global()
@Module({
  providers: [ListingService],
  exports: [ListingService],
})
export class ListingModule {}
