import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RolesController } from './adapters/http/roles.controller';
import { RolesService } from './application/roles.service';

@Module({
  imports: [AuthModule],
  controllers: [RolesController],
  providers: [RolesService],
})
export class RolesModule {}
