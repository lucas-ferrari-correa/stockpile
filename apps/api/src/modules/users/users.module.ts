import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AccessRequestsController } from './adapters/http/access-requests.controller';
import { UsersController } from './adapters/http/users.controller';
import { AccessRequestsService } from './application/access-requests.service';
import { UsersService } from './application/users.service';

@Module({
  imports: [AuthModule],
  controllers: [AccessRequestsController, UsersController],
  providers: [AccessRequestsService, UsersService],
})
export class UsersModule {}
