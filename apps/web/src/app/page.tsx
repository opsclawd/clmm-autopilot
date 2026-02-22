import { clamp, movingAverage } from '@clmm-autopilot/core';
import { loadSolanaConfig } from '@clmm-autopilot/solana';

export default function Home() {
  const config = loadSolanaConfig(process.env);
  const avg = movingAverage([2, 4, 6]);
  const bounded = clamp(12, 0, 10);

  return (
    <main className="p-6 font-sans space-y-3">
      <h1 className="text-2xl font-bold">CLMM Autopilot — M1 Dev Console</h1>
      <p className="text-sm text-gray-700">Minimal shell invoking shared workspace packages (no business logic).</p>

      <section className="text-sm">
        <h2 className="font-semibold">@clmm-autopilot/core</h2>
        <div>movingAverage([2,4,6]) = {avg}</div>
        <div>clamp(12,0,10) = {bounded}</div>
      </section>

      <section className="text-sm">
        <h2 className="font-semibold">@clmm-autopilot/solana</h2>
        <div>cluster: {config.cluster}</div>
        <div>commitment: {config.commitment}</div>
        <div>rpcUrl: {config.rpcUrl}</div>
      </section>
    </main>
  );
}
