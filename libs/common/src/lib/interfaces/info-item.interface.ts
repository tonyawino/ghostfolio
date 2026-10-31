import type { SymbolProfile } from '@ghostfolio/prisma/browser';

import { Statistics } from './statistics.interface';
import { SubscriptionOffer } from './subscription-offer.interface';

export interface InfoItem {
  baseCurrency: string;
  benchmarks: Partial<SymbolProfile>[];
  capabilities?: string[];
  countriesOfSubscribers?: string[];
  currencies: string[];
  demoAuthToken: string;
  fearAndGreedStocksMarketPrice?: number;
  globalPermissions: string[];
  isDataGatheringEnabled?: string;
  isReadOnlyMode?: boolean;
  statistics: Statistics;
  subscriptionOffer?: SubscriptionOffer;
}
