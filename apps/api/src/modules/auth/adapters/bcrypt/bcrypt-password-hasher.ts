import { compare, hash } from 'bcryptjs';
import { PasswordHasher } from '../../ports/password-hasher.port';

export const PASSWORD_HASH_COST = 12;

export class BcryptPasswordHasher implements PasswordHasher {
  hash(password: string): Promise<string> {
    return hash(password, PASSWORD_HASH_COST);
  }

  verify(password: string, passwordHash: string): Promise<boolean> {
    return compare(password, passwordHash);
  }
}
