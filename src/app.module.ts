import { Module } from '@nestjs/common';
import { HealthModule } from './health/health.module';
import { IngestionModule } from './ingestion/ingestion.module';
import { OutboxModule } from './outbox/outbox.module';
import { PaymentsModule } from './payments/payments.module';

@Module({
  imports: [HealthModule, IngestionModule, PaymentsModule, OutboxModule],
})
export class AppModule {}
