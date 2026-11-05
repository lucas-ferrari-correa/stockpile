import { AuthUser } from '@stockpile/shared';
import { Request } from 'express';

export interface AuthenticatedRequest extends Request {
  user?: AuthUser;
}
