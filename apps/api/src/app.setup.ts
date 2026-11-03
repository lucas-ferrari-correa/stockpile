import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { cleanupOpenApiDoc } from 'nestjs-zod';

export const DOCS_PATH = 'docs';

export function configureApp(app: INestApplication): void {
  app.enableCors();
  app.enableShutdownHooks();

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
