import { useMemo, useState } from 'react';
import { Link } from 'wouter';
import {
  ArrowDownUp, ArrowRight, BusFront, Clock3, Footprints, LocateFixed, MapPin,
  Navigation, Search, ShieldCheck, TrainFront, TramFront, ChevronRight,
} from 'lucide-react';
import {
  getGetRouteQueryKey, getSearchLocationsQueryKey, useGetRoute, useGetRouteHistory,
  useSearchLocations, useSearchRoutes,
} from '@workspace/api-client-react';
import type { RouteSearchInput, RouteSearchResult, TransitRouteOption } from '@workspace/api-client-react';

type Priority = RouteSearchInput['preferences']['priority'];
type PlaceField = 'origin' | 'destination';

const priorities: { id: Priority; label: string }[] = [
  { id: 'balanced', label: 'Balanced' },
  { id: 'fastest', label: 'Fastest' },
  { id: 'fewest_transfers', label: 'Fewer transfers' },
  { id: 'least_walking', label: 'Less walking' },
];

function timeText(value: string) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function modeIcon(mode: string) {
  const value = mode.toLowerCase();
  if (value.includes('metro') || value.includes('train')) return <TrainFront size={12} aria-hidden="true" />;
  if (value.includes('walk')) return <Footprints size={12} aria-hidden="true" />;
  if (value.includes('tram')) return <TramFront size={12} aria-hidden="true" />;
  return <BusFront size={12} aria-hidden="true" />;
}

function RouteMap({ route, result }: { route?: TransitRouteOption; result?: RouteSearchResult }) {
  const polyline = useMemo(() => {
    if (!route?.segments?.length) return 'M 45 212 C 92 182, 105 90, 174 126 S 262 174, 340 68';
    const points = route.segments.flatMap((segment, index) => index === 0
      ? [[segment.fromLongitude, segment.fromLatitude], [segment.toLongitude, segment.toLatitude]]
      : [[segment.toLongitude, segment.toLatitude]]);
    const lons = points.map((point) => point[0]);
    const lats = points.map((point) => point[1]);
    const minLon = Math.min(...lons), maxLon = Math.max(...lons);
    const minLat = Math.min(...lats), maxLat = Math.max(...lats);
    return points.map(([lon, lat], index) => {
      const x = 34 + ((lon - minLon) / (maxLon - minLon || 1)) * 300;
      const y = 28 + (1 - (lat - minLat) / (maxLat - minLat || 1)) * 205;
      return `${index === 0 ? 'M' : 'L'} ${x} ${y}`;
    }).join(' ');
  }, [route]);

  return (
    <section className="map-card" aria-label="Route map and journey summary">
      <div className="map-title"><span>Journey map</span><Navigation size={15} aria-hidden="true" /></div>
      <div className="map-caption">A clear view of your way across Hyderabad</div>
      <div className="map-art" role="img" aria-label="Stylized route map with origin, transfer stops and destination">
        <span className="map-label" style={{ left: '12%', top: '19%' }}>Banjara Hills</span>
        <span className="map-label" style={{ right: '11%', top: '38%' }}>Ameerpet</span>
        <span className="map-label" style={{ left: '22%', bottom: '18%' }}>Lakdikapul</span>
        <span className="map-label" style={{ right: '13%', bottom: '13%' }}>Hitech City</span>
        <svg className="map-route" viewBox="0 0 370 260" preserveAspectRatio="none" aria-hidden="true">
          <path d={polyline} fill="none" stroke="#fffdf7" strokeWidth="10" strokeLinecap="round" strokeLinejoin="round" />
          <path d={polyline} fill="none" stroke="#32816d" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
          <path d={polyline} fill="none" stroke="#e4b858" strokeWidth="1.5" strokeDasharray="2 8" strokeLinecap="round" />
        </svg>
        <span className="map-dot" style={{ left: '9%', top: '78%' }} />
        <span className="map-pin-label" style={{ left: '3%', top: '85%' }}>{result?.origin.name ?? 'Start'}</span>
        <span className="map-dot" style={{ right: '9%', top: '19%' }} />
        <span className="map-pin-label" style={{ right: '2%', top: '9%' }}>{result?.destination.name ?? 'Destination'}</span>
      </div>
      <div className="map-legend"><span className="legend-mark" /><span>Selected journey</span><span>•</span><span>{route?.segments.length ?? 0} legs</span></div>
      {route && (
        <div className="summary-strip" aria-label="Selected route details">
          <div className="summary-cell"><strong>{route.transfers}</strong><span>Transfers</span></div>
          <div className="summary-cell"><strong>{route.walkingMinutes} min</strong><span>Walking</span></div>
          <div className="summary-cell"><strong>{route.waitingMinutes} min</strong><span>Waiting</span></div>
        </div>
      )}
    </section>
  );
}

function RouteCard({ route, recommended, active, onSelect }: {
  route: TransitRouteOption; recommended: boolean; active: boolean; onSelect: () => void;
}) {
  return (
    <button type="button" className={`route-card${active ? ' active' : ''}`} onClick={onSelect}
      aria-pressed={active} data-testid={`card-route-${route.id}`}>
      <div className="route-card-top">
        <div>
          <div className="time-pair"><span>{timeText(route.departureTime)}</span><span>to</span><span>{timeText(route.arrivalTime)}</span></div>
          <div className="mode-pills" style={{ marginTop: 8 }}>
            {route.modes.map((mode, i) => <span className="mode-pill" key={`${mode}-${i}`}>{modeIcon(mode)}{mode}</span>)}
            {!route.modes.length && <span className="mode-pill"><BusFront size={12} />Public transport</span>}
          </div>
        </div>
        <div>
          {recommended && <div className="recommended-tag">Recommended</div>}
          <div className="duration" style={{ marginTop: recommended ? 7 : 0 }}>
            {route.durationMinutes} min <small>{route.transfers === 0 ? 'Direct' : `${route.transfers} transfer${route.transfers === 1 ? '' : 's'}`}</small>
          </div>
        </div>
      </div>
      <div className="route-track" aria-hidden="true">
        <span className="track-point" />
        {Array.from({ length: Math.max(1, Math.min(route.transfers + 1, 4)) }, (_, index) =>
          <span key={index} className={`track-line${index < route.transfers ? ' transfer' : ''}`} />)}
        <span className="track-point end" />
      </div>
      <div className="card-meta">
        <span>{route.walkingMinutes} min walk <span aria-hidden="true">·</span> {route.waitingMinutes} min wait</span>
        {recommended && <span>Best match · {Math.round(route.score)} score</span>}
      </div>
      <p className="route-reason">{route.reason}</p>
    </button>
  );
}

function LocationInput({ label, value, field, suggestions, onChange, onChoose, onFocus, open }: {
  label: string; value: string; field: PlaceField; suggestions: { name: string }[];
  onChange: (value: string) => void; onChoose: (name: string) => void; onFocus: (field: PlaceField) => void; open: boolean;
}) {
  return (
    <div className="field select-wrap">
      <label htmlFor={`${field}-input`}>{label}</label>
      <div className="input-wrap">
        <MapPin size={15} aria-hidden="true" />
        <input id={`${field}-input`} data-testid={`input-${field}`} value={value}
          onChange={(event) => onChange(event.target.value)} onFocus={() => onFocus(field)}
          placeholder={field === 'origin' ? 'Where are you starting?' : 'Where do you want to go?'}
          autoComplete="off" aria-autocomplete="list" aria-expanded={open && suggestions.length > 0}
          aria-controls={`${field}-suggestions`} />
      </div>
      {open && suggestions.length > 0 && (
        <div className="suggestions" id={`${field}-suggestions`} role="listbox" aria-label={`${label} suggestions`}>
          {suggestions.slice(0, 5).map((item, index) => (
            <button className="suggestion" type="button" role="option" aria-selected="false"
              key={`${item.name}-${index}`} onMouseDown={(event) => event.preventDefault()}
              onClick={() => onChoose(item.name)} data-testid={`suggestion-${field}-${index}`}>
              <MapPin size={13} style={{ verticalAlign: 'middle', marginRight: 8 }} />{item.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function HomePage() {
  const [origin, setOrigin] = useState('');
  const [destination, setDestination] = useState('');
  const [departureTime, setDepartureTime] = useState('');
  const [priority, setPriority] = useState<Priority>('balanced');
  const [focusedField, setFocusedField] = useState<PlaceField | null>(null);
  const [result, setResult] = useState<RouteSearchResult>();
  const [selectedRouteId, setSelectedRouteId] = useState('');
  const [formError, setFormError] = useState('');
  const search = useSearchRoutes();
  const history = useGetRouteHistory();
  const originParams = { q: origin.trim().length >= 2 ? origin.trim() : 'Hyderabad' };
  const destinationParams = { q: destination.trim().length >= 2 ? destination.trim() : 'Hyderabad' };
  const originLocations = useSearchLocations(originParams, { query: { enabled: origin.trim().length >= 2, queryKey: getSearchLocationsQueryKey(originParams) } });
  const destinationLocations = useSearchLocations(destinationParams, { query: { enabled: destination.trim().length >= 2, queryKey: getSearchLocationsQueryKey(destinationParams) } });
  const routeQuery = useGetRoute(result?.requestId ?? '', {
    query: { enabled: Boolean(result?.requestId), queryKey: getGetRouteQueryKey(result?.requestId ?? '') },
  });
  const data = routeQuery.data ?? result;
  const activeRoute = data?.routes.find((route) => route.id === selectedRouteId)
    ?? data?.routes.find((route) => route.id === data.recommendedRouteId)
    ?? data?.routes[0];

  const runSearch = (nextOrigin = origin, nextDestination = destination, nextDeparture = departureTime) => {
    if (nextOrigin.trim().length < 2 || nextDestination.trim().length < 2) {
      setFormError('Add an origin and destination to compare journeys.');
      return;
    }
    setFormError('');
    const input: RouteSearchInput = {
      origin: nextOrigin.trim(),
      destination: nextDestination.trim(),
      ...(nextDeparture ? { departureTime: new Date(nextDeparture).toISOString() } : {}),
      preferences: { priority },
    };
    search.mutate({ data: input }, {
      onSuccess: (response) => {
        setResult(response);
        setSelectedRouteId(response.recommendedRouteId || response.routes[0]?.id || '');
      },
      onError: () => setFormError('We couldn’t find routes just now. Check your connection and try again.'),
    });
  };

  const chooseHistory = (item: { origin: string; destination: string; departureTime: string }) => {
    setOrigin(item.origin);
    setDestination(item.destination);
    setDepartureTime('');
    runSearch(item.origin, item.destination, '');
    if (item.departureTime) setDepartureTime(item.departureTime.slice(0, 16));
  };

  const setPlace = (field: PlaceField, name: string) => {
    (field === 'origin' ? setOrigin : setDestination)(name);
    setFocusedField(null);
  };

  const routeCount = data?.routes.length ?? 0;

  return (
    <div className="route-shell">
      <header className="topbar">
        <Link href="/" className="brand" aria-label="Wayfinder home" data-testid="link-home">
          <span className="brand-mark"><Navigation size={18} strokeWidth={2.5} /></span>
          <span>wayfinder<span style={{ color: '#edc56f' }}>.</span></span>
        </Link>
        <nav className="topnav" aria-label="Main navigation">
          <Link href="/" className="active" data-testid="link-routes">Plan a trip</Link>
          <Link href="/admin" data-testid="link-network">Transit network <ChevronRight size={13} style={{ verticalAlign: 'middle' }} /></Link>
        </nav>
      </header>
      <main className="page-wrap">
        <section className="hero">
          <div>
            <div className="eyebrow">Hyderabad, made easier</div>
            <h1>A better way across town.</h1>
            <p>Compare real public transport journeys, then head out with a plan.</p>
          </div>
          <div className="hero-note"><ShieldCheck size={15} /> Practical routes, ranked around your day</div>
        </section>

        <form className="search-panel" onSubmit={(event) => { event.preventDefault(); runSearch(); }}>
          <div className="search-grid">
            <LocationInput label="From" field="origin" value={origin}
              suggestions={originLocations.data ?? []} onChange={setOrigin}
              onChoose={(name) => setPlace('origin', name)} onFocus={setFocusedField}
              open={focusedField === 'origin'} />
            <button className="swap-btn" type="button" aria-label="Swap origin and destination" data-testid="button-swap"
              onClick={() => { setOrigin(destination); setDestination(origin); setFocusedField(null); }}>
              <ArrowDownUp size={16} />
            </button>
            <LocationInput label="To" field="destination" value={destination}
              suggestions={destinationLocations.data ?? []} onChange={setDestination}
              onChoose={(name) => setPlace('destination', name)} onFocus={setFocusedField}
              open={focusedField === 'destination'} />
            <div className="field">
              <label htmlFor="departure-time">Leave at</label>
              <div className="input-wrap"><Clock3 size={15} aria-hidden="true" />
                <input id="departure-time" type="datetime-local" data-testid="input-departure-time"
                  value={departureTime} onChange={(event) => setDepartureTime(event.target.value)} />
              </div>
            </div>
            <button className="search-btn" type="submit" disabled={search.isPending} data-testid="button-search">
              <Search size={16} />{search.isPending ? 'Finding routes…' : 'Find journeys'}
            </button>
          </div>
          <div className="preference-row" role="group" aria-label="Route preference">
            <span>Prioritize</span>
            {priorities.map((option) => (
              <button key={option.id} type="button" className={`pref-chip${priority === option.id ? ' selected' : ''}`}
                aria-pressed={priority === option.id} onClick={() => setPriority(option.id)}
                data-testid={`button-priority-${option.id}`}>{option.label}</button>
            ))}
          </div>
          {formError && <div className="error-box" role="alert" data-testid="status-search-error">{formError}</div>}
        </form>

        <div className="section-head">
          <div><h2>{data ? 'Your route options' : 'Ready when you are'}</h2>
            <p>{data ? `${routeCount} journeys compared from ${data.origin.name} to ${data.destination.name}` : 'A few details in, a clearer journey out.'}</p></div>
          {data && <div className="eyebrow">{data.provider}</div>}
        </div>

        {!data && search.isPending && <div className="results-layout"><div className="results-column"><div className="loader" /><div className="loader" /><div className="loader" /></div><div className="loader" /></div>}
        {!data && !search.isPending && (
          <div className="empty-state" data-testid="empty-route-results">
            <LocateFixed size={27} strokeWidth={1.5} />
            <h3>Start with the places you have in mind</h3>
            <p>We’ll compare transit options by journey time, transfers, walking and wait.</p>
          </div>
        )}
        {data && routeCount === 0 && <div className="empty-state"><MapPin size={25} /><h3>No journeys found for this trip</h3><p>Try a nearby stop or change your route preference.</p></div>}
        {data && routeCount > 0 && (
          <div className="results-layout">
            <div className="results-column" aria-label="Ranked journey options">
              {data.routes.map((route) => (
                <RouteCard key={route.id} route={route} recommended={route.id === data.recommendedRouteId}
                  active={route.id === activeRoute?.id} onSelect={() => setSelectedRouteId(route.id)} />
              ))}
              {routeQuery.isLoading && <div className="loader" aria-label="Loading saved route details" />}
              {routeQuery.isError && <p className="route-reason" role="status">Showing the route comparison from your latest search.</p>}
            </div>
            <RouteMap route={activeRoute} result={data} />
          </div>
        )}

        <section className="recent-panel">
          <div className="section-head" style={{ margin: '0 0 14px' }}>
            <div><h2>Recent searches</h2><p>Pick up where you left off.</p></div>
            <span className="eyebrow">Your latest trips</span>
          </div>
          {history.isLoading && <div className="loader" style={{ height: 54 }} aria-label="Loading recent searches" />}
          {history.isError && <div className="error-box" role="status">Recent searches are temporarily unavailable.</div>}
          {history.data?.length ? (
            <div className="recent-list">
              {history.data.slice(0, 6).map((item) => (
                <button className="recent-item" type="button" key={item.id}
                  onClick={() => chooseHistory(item)} data-testid={`button-recent-${item.id}`}>
                  <MapPin size={13} /><span>{item.origin}</span><ArrowRight size={12} /><span>{item.destination}</span>
                  <span style={{ color: '#929d93', marginLeft: 3 }}>{item.departureTime ? timeText(item.departureTime) : ''}</span>
                </button>
              ))}
            </div>
          ) : !history.isLoading && !history.isError ? (
            <div className="recent-list"><span className="route-reason">Your searches will appear here when available.</span></div>
          ) : null}
        </section>
      </main>
    </div>
  );
}
