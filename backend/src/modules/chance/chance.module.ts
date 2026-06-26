import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Chance } from './entities/chance.entity';
import { ChanceService } from './chance.service';
import { ChanceController } from './chance.controller';
import { ChanceValidationFilter, ChanceExceptionFilter } from './filters/chance-validation.filter';

@Module({
  imports: [TypeOrmModule.forFeature([Chance])],
  providers: [
    ChanceService,
    ChanceValidationFilter,
    ChanceExceptionFilter,
  ],
  controllers: [ChanceController],
  exports: [TypeOrmModule],
})
export class ChanceModule {}
