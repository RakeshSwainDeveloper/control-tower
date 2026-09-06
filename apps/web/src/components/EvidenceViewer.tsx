import { useEffect, useState } from 'react';
import { Camera, MapPin, X, User } from 'lucide-react';
import { api } from '../lib/api.js';

/**
 * The evidence viewer.
 *
 * Full-screen with a metadata overlay: time, GPS, who captured it, and in what
 * capacity. That overlay is the entire point. A photograph on its own proves
 * that something was photographed; a photograph with a time, a location and
 * "captured by Ramesh as Site Supervisor" is what makes a disputed claim
 * arguable six months later.
 */
export interface EvidenceAsset {
  id: string;
  kind: string;
  url?: string;
  mime_type: string;
  captured_at_device: string;
  captured_by_name?: string;
  captured_responsibility?: string | null;
  gps_lat?: string | null;
  gps_lng?: string | null;
  gps_unavailable_reason?: string | null;
  caption?: string | null;
}

export function EvidenceStrip({
  assets, onOpen, emptyHint,
}: { assets: EvidenceAsset[]; onOpen?: (a: EvidenceAsset) => void; emptyHint?: string }) {
  const [open, setOpen] = useState<EvidenceAsset | null>(null);
  if (assets.length === 0) {
    return <p className="small muted row" style={{ gap: 'var(--s2)' }}>
      <Camera size={15} aria-hidden /> {emptyHint ?? 'No photographs attached'}
    </p>;
  }
  return (
    <>
      <div className="thumb-grid">
        {assets.map((a) => (
          <button
            key={a.id} type="button" className="thumb"
            onClick={() => (onOpen ? onOpen(a) : setOpen(a))}
            aria-label={`Open photograph taken ${new Date(a.captured_at_device).toLocaleString()}`}
          >
            {a.url ? <img src={a.url} alt="" loading="lazy" /> : <span className="sr-only">Photo</span>}
          </button>
        ))}
      </div>
      {open ? <EvidenceLightbox asset={open} onClose={() => setOpen(null)} /> : null}
    </>
  );
}

export function EvidenceLightbox({ asset, onClose }: { asset: EvidenceAsset; onClose: () => void }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);

  const gps = asset.gps_lat && asset.gps_lng
    ? `${Number(asset.gps_lat).toFixed(5)}, ${Number(asset.gps_lng).toFixed(5)}`
    : null;

  return (
    <div
      role="dialog" aria-modal="true" aria-label="Photograph"
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 50, background: 'rgb(2 6 23 / 0.92)',
        display: 'flex', flexDirection: 'column',
      }}
    >
      <div className="row-between" style={{ padding: 'var(--s3) var(--s4)', color: '#fff' }}>
        <span className="small">{new Date(asset.captured_at_device).toLocaleString()}</span>
        <button type="button" className="btn btn-ghost" style={{ color: '#fff' }} onClick={onClose}>
          <X size={20} aria-hidden /><span className="sr-only">Close</span>
        </button>
      </div>
      <div className="grow" style={{ display: 'grid', placeItems: 'center', minHeight: 0, padding: 'var(--s4)' }}>
        {asset.url ? (
          <img src={asset.url} alt={asset.caption ?? 'Site photograph'}
               style={{ maxHeight: '100%', maxWidth: '100%', objectFit: 'contain' }} />
        ) : <span style={{ color: '#fff' }}>Image unavailable</span>}
      </div>
      {/* The overlay is not decoration. It is the evidentiary value. */}
      <div className="stack-2" style={{ padding: 'var(--s4)', color: '#e2e8f0', fontSize: 'var(--text-sm)' }}>
        {asset.caption ? <span>{asset.caption}</span> : null}
        <span className="row" style={{ gap: 'var(--s2)' }}>
          <User size={14} aria-hidden />
          {asset.captured_by_name ?? 'Unknown'}
          {asset.captured_responsibility ? ` · as ${asset.captured_responsibility}` : ''}
        </span>
        <span className="row" style={{ gap: 'var(--s2)' }}>
          <MapPin size={14} aria-hidden />
          {gps ?? asset.gps_unavailable_reason ?? 'Location not recorded'}
        </span>
      </div>
    </div>
  );
}

/** Fetch the linked evidence for a record, signed-URL style. */
export async function loadEvidence(entityType: string, entityId: string): Promise<EvidenceAsset[]> {
  const res = await api.get<{ data: EvidenceAsset[] }>(
    `/evidence?entity_type=${encodeURIComponent(entityType)}&entity_id=${encodeURIComponent(entityId)}`,
  );
  return res.data ?? [];
}
