import { DataSource } from '@ghostfolio/prisma/enums';

import { ApiService } from '@ghostfolio/api/services/api/api.service';
import { SymbolProfileService } from '@ghostfolio/api/services/symbol-profile/symbol-profile.service';

import { AssetProfilesController } from './asset-profiles.controller';
import { AssetProfilesService } from './asset-profiles.service';

describe('AssetProfilesController identity endpoint', () => {
  const currentUserId = 'current-user-id';
  let getProfileIdentity: jest.Mock;
  let controller: AssetProfilesController;

  beforeEach(() => {
    getProfileIdentity = jest.fn();
    controller = new AssetProfilesController(
      {} as ApiService,
      { getProfileIdentity } as unknown as AssetProfilesService,
      { user: { id: currentUserId } } as any,
      {} as SymbolProfileService
    );
  });

  it('returns only identity fields for a shared MANUAL profile', async () => {
    getProfileIdentity.mockResolvedValue({
      id: 'profile-id',
      dataSource: DataSource.MANUAL,
      symbol: 'SYNTH',
      userId: null,
      name: 'must not be returned'
    });

    await expect(
      controller.getAssetProfileIdentity(DataSource.MANUAL, 'SYNTH')
    ).resolves.toEqual({
      assetProfile: { id: 'profile-id', symbol: 'SYNTH', userId: null }
    });
  });

  it('returns only identity fields for a profile owned by the caller', async () => {
    getProfileIdentity.mockResolvedValue({
      id: 'profile-id',
      dataSource: DataSource.MANUAL,
      symbol: 'SYNTH',
      userId: currentUserId
    });

    await expect(
      controller.getAssetProfileIdentity(DataSource.MANUAL, 'SYNTH')
    ).resolves.toEqual({
      assetProfile: {
        id: 'profile-id',
        symbol: 'SYNTH',
        userId: currentUserId
      }
    });
  });

  it('hides profiles owned by another user', async () => {
    getProfileIdentity.mockResolvedValue({
      id: 'private-profile-id',
      dataSource: DataSource.MANUAL,
      symbol: 'SYNTH',
      userId: 'another-user-id'
    });

    await expect(
      controller.getAssetProfileIdentity(DataSource.MANUAL, 'SYNTH')
    ).rejects.toMatchObject({ status: 404 });
  });

  it('does not expose identity for non-MANUAL data sources', async () => {
    getProfileIdentity.mockResolvedValue({
      id: 'profile-id',
      dataSource: DataSource.YAHOO,
      symbol: 'SYNTH',
      userId: null
    });

    await expect(
      controller.getAssetProfileIdentity(DataSource.YAHOO, 'SYNTH')
    ).rejects.toMatchObject({ status: 404 });
  });
});
