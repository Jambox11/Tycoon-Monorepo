import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from 'nest-winston';
import { GracefulShutdownService } from './graceful-shutdown.service';
import { createNestWinstonMock } from '../../../test/mocks/nest-winston.mock';

interface Drainable {
  onApplicationShutdown?: (signal?: string) => Promise<void> | void;
}

describe('GracefulShutdownService', () => {
  let service: GracefulShutdownService;
  let logger: ReturnType<typeof createNestWinstonMock>;

  beforeEach(async () => {
    logger = createNestWinstonMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GracefulShutdownService,
        { provide: Logger, useValue: logger },
      ],
    }).compile();

    service = module.get<GracefulShutdownService>(GracefulShutdownService);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('awaits all registered drainable resources on shutdown', async () => {
    const first = jest.fn().mockResolvedValue(undefined);
    const second = jest.fn().mockResolvedValue(undefined);

    service.register({ onApplicationShutdown: first } as Drainable);
    service.register({ onApplicationShutdown: second } as Drainable);

    await service.onApplicationShutdown('SIGTERM');

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('resolves without hanging when a drainable exceeds the timeout', async () => {
    jest.useFakeTimers();

    const hanging = jest.fn().mockImplementation(() => new Promise<void>(() => {}));
    service.register({ onApplicationShutdown: hanging } as Drainable);

    const shutdown = service.onApplicationShutdown('SIGTERM');

    jest.advanceTimersByTime(service.timeoutMs ?? 30_000);

    await expect(shutdown).resolves.toBeUndefined();
    expect(hanging).toHaveBeenCalledTimes(1);
  });

  it('logs a warning when the drain timeout is exceeded', async () => {
    jest.useFakeTimers();

    const hanging = jest.fn().mockImplementation(() => new Promise<void>(() => {}));
    service.register({ onApplicationShutdown: hanging } as Drainable);

    const shutdown = service.onApplicationShutdown('SIGTERM');

    jest.advanceTimersByTime(service.timeoutMs ?? 30_000);
    await shutdown;

    expect(logger.warn).toHaveBeenCalled();
  });
});
