import { InfoService } from './info.service';

describe('public info capabilities', () => {
  it('advertises the non-sensitive versioned activity create contract', async () => {
    const service = Object.assign(Object.create(InfoService.prototype), {
      configurationService: { get: jest.fn().mockReturnValue(false) },
      benchmarkService: {
        getBenchmarkAssetProfiles: jest.fn().mockResolvedValue([])
      },
      propertyService: {
        getByKey: jest.fn().mockResolvedValue(undefined),
        isUserSignupEnabled: jest.fn().mockResolvedValue(false)
      },
      subscriptionService: {
        getSubscriptionOffer: jest.fn().mockResolvedValue(undefined)
      },
      exchangeRateDataService: {
        getCurrencies: jest.fn().mockReturnValue(['USD'])
      }
    });
    const info = await service.get();
    expect(info.capabilities).toContain('activity-create-idempotency-v1');
  });
});
