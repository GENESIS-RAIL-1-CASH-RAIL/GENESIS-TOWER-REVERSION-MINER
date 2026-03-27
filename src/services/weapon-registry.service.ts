// ─── Weapon Registry Service — Self-Registration Protocol (v4.12) ────────────

interface WeaponManifest {
  weaponId: string;
  service: string;
  port: number;
  deploymentClass: "STRIKE" | "DEFENCE" | "RECON" | "STEALTH" | "INTEL" | "SUPPORT";
  purpose: string;
  endpoints: number;
  loops: number;
  spark: string;
  academicBasis: string;
  registeredAt: string;
}

interface RegistrationTarget {
  url: string;
  endpoint: string;
  label: string;
}

export class WeaponRegistryService {
  private manifest: WeaponManifest;
  private registered: boolean = false;
  private registrationResults: { target: string; success: boolean; timestamp: number }[] = [];

  private targets: RegistrationTarget[];

  constructor(manifest: WeaponManifest) {
    this.manifest = manifest;
    this.targets = [
      { url: process.env.CIA_URL || "http://genesis-cia:8797", endpoint: "/intel", label: "CIA" },
      { url: process.env.DARPA_URL || "http://genesis-darpa:8840", endpoint: "/intel", label: "DARPA" },
      { url: process.env.SKUNKWORKS_URL || "http://genesis-skunkworks:8841", endpoint: "/intel", label: "SKUNKWORKS" },
      { url: process.env.LABS_URL || "http://genesis-labs:8845", endpoint: "/weapons/register", label: "LABS" },
      { url: process.env.WHITEBOARD_URL || "http://genesis-whiteboard:8710", endpoint: "/ingest", label: "WHITEBOARD" },
      { url: process.env.GTC_URL || "http://genesis-gtc:8650", endpoint: "/ingest", label: "GTC" },
      { url: process.env.TOOLKIT_URL || "http://genesis-toolkit:8820", endpoint: "/services/register", label: "TOOLKIT" },
    ];
  }

  async register(): Promise<{ success: boolean; reached: number; total: number }> {
    if (this.registered) {
      return { success: true, reached: this.registrationResults.filter(r => r.success).length, total: this.targets.length };
    }

    const payload = {
      source: "WEAPON_REGISTRY",
      type: "WEAPON_ENTERED_SERVICE",
      manifest: this.manifest,
      timestamp: Date.now(),
    };

    console.log(`[REGISTRY] Announcing ${this.manifest.weaponId} (${this.manifest.service}) to ${this.targets.length} upstream consumers...`);

    const results = await Promise.allSettled(
      this.targets.map(async (target) => {
        try {
          const res = await fetch(`${target.url}${target.endpoint}`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-weapon": this.manifest.weaponId,
              "x-registration": "true",
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(5000),
          });
          const success = res.ok;
          this.registrationResults.push({ target: target.label, success, timestamp: Date.now() });
          if (success) console.log(`[REGISTRY] ${target.label} — registered`);
          else console.log(`[REGISTRY] ${target.label} — responded ${res.status}`);
          return success;
        } catch {
          this.registrationResults.push({ target: target.label, success: false, timestamp: Date.now() });
          console.log(`[REGISTRY] ${target.label} — unreachable (will retry on next broadcast cycle)`);
          return false;
        }
      })
    );

    const reached = results.filter(r => r.status === "fulfilled" && r.value === true).length;
    this.registered = reached > 0;

    console.log(`[REGISTRY] ${this.manifest.weaponId} registration: ${reached}/${this.targets.length} targets reached`);
    return { success: this.registered, reached, total: this.targets.length };
  }

  isRegistered(): boolean {
    return this.registered;
  }

  getManifest(): WeaponManifest {
    return this.manifest;
  }

  getRegistrationResults(): { target: string; success: boolean; timestamp: number }[] {
    return this.registrationResults;
  }

  getStatus(): { registered: boolean; manifest: WeaponManifest; results: { target: string; success: boolean; timestamp: number }[] } {
    return {
      registered: this.registered,
      manifest: this.manifest,
      results: this.registrationResults,
    };
  }
}
