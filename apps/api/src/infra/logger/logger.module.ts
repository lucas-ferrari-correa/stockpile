import { randomUUID } from 'node:crypto';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Module } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import { AppConfigService } from '../config/app-config.service';

export const REQUEST_ID_HEADER = 'x-request-id';

function resolveRequestId(req: IncomingMessage, res: ServerResponse): string {
  const header = req.headers[REQUEST_ID_HEADER];
  const requestId = typeof header === 'string' && header.length > 0 ? header : randomUUID();
  res.setHeader(REQUEST_ID_HEADER, requestId);
  return requestId;
}

@Module({
  imports: [
    PinoLoggerModule.forRootAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        pinoHttp: {
          level: config.get('LOG_LEVEL'),
          genReqId: resolveRequestId,
          redact: ['req.headers.authorization', 'req.body.password', '*.password'],
          autoLogging: { ignore: (req: IncomingMessage): boolean => req.url === '/health' },
        },
      }),
    }),
  ],
})
export class LoggerModule {}
