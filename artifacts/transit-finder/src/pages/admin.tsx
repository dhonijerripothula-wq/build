import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import { Activity, ArrowLeft, BusFront, Check, Database, FileArchive, FileUp, MapPin, RefreshCw, TrainFront, UploadCloud } from 'lucide-react';
import {
  getGetGtfsStatusQueryKey, getGetTransitLinesQueryKey, getGetTransitStopsQueryKey,
  useGetGtfsStatus, useGetTransitLines, useGetTransitStops, useImportGtfs,
} from '@workspace/api-client-react';

function count(value?: number) {
  return typeof value === 'number' ? value.toLocaleString() : '—';
}

function errorText(error: unknown) {
  if (error instanceof Error) return error.message;
  return 'The request could not be completed. Please try again.';
}

export default function AdminPage() {
  const [file, setFile] = useState<File | null>(null);
  const [importMessage, setImportMessage] = useState('');
  const queryClient = useQueryClient();
  const status = useGetGtfsStatus();
  const lines = useGetTransitLines();
  const stops = useGetTransitStops(undefined, { query: { queryKey: getGetTransitStopsQueryKey(undefined) } });
  const importer = useImportGtfs({
    mutation: {
      onSuccess: (response) => {
        setImportMessage(`Import complete — ${count(response.imported.stops)} stops and ${count(response.imported.trips)} trips are ready.`);
        setFile(null);
        void queryClient.invalidateQueries({ queryKey: getGetGtfsStatusQueryKey() });
        void queryClient.invalidateQueries({ queryKey: getGetTransitLinesQueryKey() });
        void queryClient.invalidateQueries({ queryKey: getGetTransitStopsQueryKey(undefined) });
      },
      onError: (error) => setImportMessage(errorText(error)),
    },
  });
  const data = status.data;
  const lineList = lines.data ?? [];
  const stopList = stops.data ?? [];

  const upload = () => {
    if (!file) {
      setImportMessage('Choose a GTFS ZIP file before importing.');
      return;
    }
    if (!file.name.toLowerCase().endsWith('.zip')) {
      setImportMessage('The transit feed must be a ZIP archive.');
      return;
    }
    setImportMessage('');
    importer.mutate({ data: { file } });
  };

  return (
    <div className="route-shell">
      <header className="topbar">
        <Link href="/" className="brand" aria-label="Wayfinder home" data-testid="link-home">
          <span className="brand-mark"><Activity size={18} strokeWidth={2.5} /></span>
          <span>wayfinder<span style={{ color: '#edc56f' }}>.</span></span>
        </Link>
        <nav className="topnav" aria-label="Main navigation">
          <Link href="/" data-testid="link-routes">Plan a trip</Link>
          <Link href="/admin" className="active" data-testid="link-network">Transit network</Link>
        </nav>
      </header>
      <main className="admin-wrap">
        <Link href="/" className="eyebrow" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, textDecoration: 'none' }} data-testid="link-back-routes">
          <ArrowLeft size={13} /> Back to route finder
        </Link>
        <section className="hero" style={{ padding: '25px 0 0' }}>
          <div><div className="eyebrow">Network operations</div><h1>Transit data, at a glance.</h1>
            <p>See which network powers journey planning and manage the latest feed.</p></div>
          <div className="hero-note"><Database size={15} /> Hyderabad public transport</div>
        </section>
        {status.isError && (
          <div className="error-box" role="alert" data-testid="status-admin-error">
            Couldn’t load network status. <button type="button" onClick={() => void status.refetch()} style={{ border: 0, background: 'none', textDecoration: 'underline', color: 'inherit', cursor: 'pointer' }} data-testid="button-retry-status">Try again</button>
          </div>
        )}
        <div className="admin-grid">
          <section className="admin-card" aria-labelledby="network-status-title">
            <h2 id="network-status-title">Network status</h2>
            <p>Current source and imported service coverage.</p>
            {status.isLoading ? <div className="loader" aria-label="Loading network status" /> : data ? (
              <>
                <span className="status-badge" data-testid="status-network-source"><span className="status-dot" />{data.isDemo ? 'Demo network' : 'Live transit feed'} · {data.provider}</span>
                <div className="stat-grid">
                  <div className="stat-box" data-testid="value-stops"><strong>{count(data.stops)}</strong><span>Stops</span></div>
                  <div className="stat-box" data-testid="value-routes"><strong>{count(data.routes)}</strong><span>Routes</span></div>
                  <div className="stat-box" data-testid="value-trips"><strong>{count(data.trips)}</strong><span>Trips</span></div>
                </div>
                <div className="network-list">
                  <div className="network-row"><span>Data source</span><strong>{data.provider}</strong></div>
                  <div className="network-row"><span>Last imported</span><strong>{data.importedAt ? new Date(data.importedAt).toLocaleString() : 'Not imported yet'}</strong></div>
                  <div className="network-row"><span>Feed import</span><strong>{data.importEnabled ? 'Enabled' : 'Unavailable'}</strong></div>
                </div>
              </>
            ) : <div className="empty-state"><Database size={22} /><h3>Status unavailable</h3><p>Network figures will appear when the data service is reachable.</p></div>}
          </section>

          <section className="admin-card" aria-labelledby="feed-import-title">
            <h2 id="feed-import-title">Import a GTFS feed</h2>
            <p>Upload a transit agency ZIP archive to refresh the network used in journey results.</p>
            {data?.importEnabled ? (
              <>
                <label className="upload-zone" htmlFor="gtfs-file">
                  <UploadCloud size={24} />
                  <strong>{file ? 'Replace selected feed' : 'Choose a GTFS ZIP file'}</strong>
                  <span>ZIP archive · Keep the original agency feed format</span>
                  <input id="gtfs-file" type="file" accept=".zip,application/zip" data-testid="input-gtfs-file"
                    onChange={(event) => { setFile(event.target.files?.[0] ?? null); setImportMessage(''); }} />
                </label>
                {file && <div className="upload-file" data-testid="text-selected-file"><FileArchive size={15} /><span>{file.name}</span><span style={{ marginLeft: 'auto' }}>{(file.size / 1024 / 1024).toFixed(1)} MB</span></div>}
                <button className="search-btn admin-action" type="button" onClick={upload} disabled={importer.isPending}
                  data-testid="button-import-gtfs"><FileUp size={15} />{importer.isPending ? 'Importing feed…' : 'Import transit feed'}</button>
                {importMessage && <div className={importer.isError ? 'error-box' : 'upload-file'} role={importer.isError ? 'alert' : 'status'} data-testid="status-import-result">
                  {!importer.isError && <Check size={14} />}{importMessage}</div>}
              </>
            ) : (
              <div className="empty-state" style={{ padding: 24 }}><FileArchive size={22} /><h3>{data?.importEnabled === false ? 'Import is not enabled' : 'Checking feed permissions'}</h3><p>{data?.importEnabled === false ? 'This server does not currently accept feed uploads.' : 'Import controls appear when the network status is ready.'}</p></div>
            )}
          </section>
        </div>
        <section className="admin-card" style={{ marginTop: 18 }} aria-labelledby="lines-title">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
            <div><h2 id="lines-title">Service directory</h2><p>Lines and stop coverage present in the active network.</p></div>
            <button type="button" onClick={() => { void lines.refetch(); void stops.refetch(); void status.refetch(); }}
              aria-label="Refresh network data" className="swap-btn" style={{ margin: 0 }} data-testid="button-refresh-network"><RefreshCw size={15} /></button>
          </div>
          {lines.isLoading || stops.isLoading ? <div className="loader" aria-label="Loading service directory" /> :
            lines.isError || stops.isError ? <div className="error-box" role="alert">Service directory could not be loaded. Use refresh to try again.</div> :
              <>
                <div className="stat-grid" style={{ maxWidth: 460, marginTop: 0 }}>
                  <div className="stat-box"><strong>{count(lineList.length)}</strong><span>Services</span></div>
                  <div className="stat-box"><strong>{count(stopList.length)}</strong><span>Listed stops</span></div>
                  <div className="stat-box"><strong>{count(lineList.reduce((total, line) => total + line.stopCount, 0))}</strong><span>Line-stop links</span></div>
                </div>
                <div className="network-list">
                  {lineList.length ? lineList.map((line) => (
                    <div className="network-row" key={line.id} data-testid={`row-line-${line.id}`}>
                      <span><span className="line-swatch" style={{ backgroundColor: line.color || '#43806f' }} />{line.name}</span>
                      <strong>{line.mode} · {count(line.stopCount)} stops</strong>
                    </div>
                  )) : <div className="route-reason">No service lines are listed in this feed.</div>}
                  {stopList.slice(0, 4).map((stop) => (
                    <div className="network-row" key={`stop-${stop.id}`} data-testid={`row-stop-${stop.id}`}>
                      <span><MapPin size={12} style={{ verticalAlign: 'middle', marginRight: 7 }} />{stop.name}</span>
                      <strong>{stop.lines?.join(', ') || 'Stop'}</strong>
                    </div>
                  ))}
                </div>
              </>}
        </section>
        <p className="route-reason" style={{ marginTop: 16 }}><BusFront size={13} style={{ verticalAlign: 'middle', marginRight: 5 }} /><TrainFront size={13} style={{ verticalAlign: 'middle', marginRight: 7 }} />Journey suggestions are computed from the active data source.</p>
      </main>
    </div>
  );
}
