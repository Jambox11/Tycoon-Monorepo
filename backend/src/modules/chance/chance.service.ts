import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Chance } from './entities/chance.entity';
import { CreateChanceDto } from './dto/create-chance.dto';
import { ChanceType } from './enums/chance-type.enum';
import { ListChancesQueryDto } from './dto/list-chances-query.dto';
import { PaginationService, PaginatedResponse } from '../../common';
import {
  NoChanceCardsAvailableException,
  MissingRequiredFieldException,
  InvalidChanceTypeException,
} from './exceptions/chance-exceptions';
import { secureRandomInt } from '../../common/crypto-secure-random';

@Injectable()
export class ChanceService {
  constructor(
    @InjectRepository(Chance)
    private readonly chanceRepository: Repository<Chance>,
    private readonly paginationService: PaginationService,
  ) {}

  async findAll(queryDto: ListChancesQueryDto): Promise<PaginatedResponse<Chance>> {
    const queryBuilder = this.chanceRepository.createQueryBuilder('chance');
    return this.paginationService.paginate(
      queryBuilder,
      queryDto,
      undefined,
      ['id', 'createdAt', 'updatedAt'],
    );
  }

  async drawCard(): Promise<Chance> {
    const count = await this.chanceRepository.count();
    if (count === 0) {
      throw new NoChanceCardsAvailableException();
    }
    const randomIndex = secureRandomInt(count);
    const [card] = await this.chanceRepository.find({
      order: { id: 'ASC' },
      skip: randomIndex,
      take: 1,
    });
    return card;
  }
  async createChance(createChanceDto: CreateChanceDto): Promise<Chance> {
    const trimmedInstruction = createChanceDto.instruction.trim();
    if (!trimmedInstruction || trimmedInstruction.length === 0) {
      throw new MissingRequiredFieldException(
        'instruction',
        'Cannot be empty',
      );
    }

    // Validate amount is provided for reward/penalty types
    if (
      createChanceDto.type === ChanceType.REWARD ||
      createChanceDto.type === ChanceType.PENALTY
    ) {
      if (
        createChanceDto.amount === undefined ||
        createChanceDto.amount === null
      ) {
        throw new MissingRequiredFieldException(
          'amount',
          `Required for ${createChanceDto.type} type chance cards`,
        );
      }
    }

    // Validate position is provided for move type
    if (createChanceDto.type === ChanceType.MOVE) {
      if (
        createChanceDto.position === undefined ||
        createChanceDto.position === null
      ) {
        throw new MissingRequiredFieldException(
          'position',
          'Required for move type chance cards',
        );
      }
    }

    const chance = this.chanceRepository.create({
      instruction: trimmedInstruction,
      type: createChanceDto.type,
      amount: createChanceDto.amount ?? null,
      position: createChanceDto.position ?? null,
      extra: createChanceDto.extra ?? null,
    });

    return await this.chanceRepository.save(chance);
  }
}
