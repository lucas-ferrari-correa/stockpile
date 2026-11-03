import { Injectable } from '@nestjs/common';
import { Env, parseEnv } from './env.schema';

@Injectable()
export class AppConfigService {
  private readonly env: Env = parseEnv(process.env);

  get<K extends keyof Env>(key: K): Env[K] {
    return this.env[key];
  }
}
