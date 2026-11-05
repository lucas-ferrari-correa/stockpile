CREATE TYPE "user_event_type" AS ENUM ('REQUESTED', 'APPROVED', 'REJECTED', 'BLOCKED', 'DELETED', 'ROLE_CHANGED');

CREATE TABLE "user_events" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "actor_id" UUID,
    "type" "user_event_type" NOT NULL,
    "re_registration" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "user_events_user_id_created_at_idx" ON "user_events"("user_id", "created_at");

ALTER TABLE "user_events" ADD CONSTRAINT "user_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_events" ADD CONSTRAINT "user_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
