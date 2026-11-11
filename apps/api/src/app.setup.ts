import { INestApplication } from '@nestjs/common';
import { ExpressAdapter } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { cleanupOpenApiDoc } from 'nestjs-zod';
import { AppConfigService } from './infra/config/app-config.service';

export const DOCS_PATH = 'docs';

export function configureApp(app: INestApplication): void {
  app.enableCors();
  app.enableShutdownHooks();

  const trustProxyHops = app.get(AppConfigService).get('TRUST_PROXY_HOPS');
  const httpAdapter = app.getHttpAdapter();
  if (trustProxyHops > 0 && httpAdapter instanceof ExpressAdapter) {
    httpAdapter.set('trust proxy', trustProxyHops);
  }

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Stockpile API')
      .setDescription('Import supplier price lists from CSV and browse products with currency conversions')
      .setVersion('1.0.0')
      .addBearerAuth()
      .build(),
  );
  SwaggerModule.setup(DOCS_PATH, app, cleanupOpenApiDoc(document), { jsonDocumentUrl: `${DOCS_PATH}-json` });
}
