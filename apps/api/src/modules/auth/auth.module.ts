import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { AppConfigService } from '../../infra/config/app-config.service';
import { BcryptPasswordHasher } from './adapters/bcrypt/bcrypt-password-hasher';
import { AuthController } from './adapters/http/auth.controller';
import { JwtAuthGuard } from './adapters/http/jwt-auth.guard';
import { PermissionsGuard } from './adapters/http/permissions.guard';
import { RateLimitModule } from './adapters/http/rate-limit.module';
import { AuthService } from './application/auth.service';
import { PASSWORD_HASHER } from './ports/password-hasher.port';

@Module({
  imports: [
    RateLimitModule,
    JwtModule.registerAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        secret: config.get('JWT_SECRET'),
        signOptions: { expiresIn: config.get('JWT_EXPIRES_IN_SECONDS') },
        verifyOptions: { algorithms: ['HS256'] },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    { provide: PASSWORD_HASHER, useClass: BcryptPasswordHasher },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
  exports: [AuthService, PASSWORD_HASHER],
})
export class AuthModule {}
