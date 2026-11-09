import { Prisma } from '@prisma/client';
import { PrismaService } from './prisma.service';

const SERIALIZATION_RETRIES = 3;

function isSerializationFailure(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034';
}

export async function runSerializable<T>(
  prisma: PrismaService,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await prisma.$transaction(work, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (!isSerializationFailure(error) || attempt >= SERIALIZATION_RETRIES) {
        throw error;
      }
    }
  }
}
