import { Notice } from 'obsidian';
import type { Tier } from '../types';
import { LicenseValidator } from './LicenseValidator';
import { FREE_MAX_PROFILES } from '../constants';

export class TierError extends Error {
  constructor(public readonly feature: string) {
    super(`"${feature}" requires Remote SSH Pro`);
  }
}

export class LicenseGate {
  private tier: Tier = 'free';
  private email = '';

  async initialize(licenseKey: string): Promise<void> {
    if (!licenseKey) { this.tier = 'free'; return; }
    const payload = await LicenseValidator.validate(licenseKey);
    if (payload) {
      this.tier  = 'pro';
      this.email = payload.email;
    } else {
      this.tier = 'free';
      new Notice('Remote SSH: License key is invalid or expired. Running in Free mode.');
    }
  }

  get isPro(): boolean { return this.tier === 'pro'; }
  get tierLabel(): string { return this.tier === 'pro' ? 'Pro' : 'Free'; }
  get licenseEmail(): string { return this.email; }

  requirePro(feature: string): void {
    if (!this.isPro) {
      new Notice(`Remote SSH: "${feature}" requires the Pro license. Enter your key in Settings.`);
      throw new TierError(feature);
    }
  }

  canAddProfile(currentCount: number): boolean {
    if (this.isPro) return true;
    return currentCount < FREE_MAX_PROFILES;
  }

  effectivePollInterval(requestedSec: number): number {
    if (this.isPro) return requestedSec;
    return Math.max(requestedSec, 30);
  }
}
