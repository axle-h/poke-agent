import { useCallback, useEffect, useMemo, useState } from 'react';
import { gameName, type RunStatus, type UsageView } from './api';
import { BattleScriptPanel } from './components/BattleScriptPanel';
import { Conversation, hasTurns, type LogMode } from './components/Conversation';
import { Highlights } from './components/Highlights';
import { Leaderboard } from './components/Leaderboard';
import { Menu } from './components/Menu';
import { Opponent } from './components/Opponent';
import { PlanPanel } from './components/PlanPanel';
import { Screen, describeRemaining } from './components/Screen';
import { SoundButton } from './components/SoundButton';
import { StatusPanel } from './components/StatusPanel';
import { useEventStream } from './useEventStream';
import { useWakeLock } from './useWakeLock';

/** The phone's tabs; Plan and Script are offered only while they have content. On a desk only
    `log` and `highlights` mean anything, choosing what the right-hand column shows. */
type PaneTab = 'log' | 'status' | 'highlights' | 'plan' | 'script';

const LOG_MODE_KEY = 'gb.log';

export function App() {
  const { status, entries, connection, usage, run, plan, loadOlderPlans, battleScript, speed } = useEventStream();
  // Holds the screen on while the page is visible, so a phone watching does not lock; see the hook.
  useWakeLock();
  const [tab, setTab] = useState<PaneTab>('log');
  const [mode, setMode] = useState<LogMode>(() => storedMode());
  const [raw, setRaw] = useState(false);
  const [board, setBoard] = useState(false);
  const closeBoard = useCallback(() => setBoard(false), []);
  const chooseMode = useCallback((next: LogMode) => {
    setMode(next);
    try {
      localStorage.setItem(LOG_MODE_KEY, next);
    } catch {
      // A private window: the choice lasts as long as the page.
    }
  }, []);
  // A selection whose pane has emptied falls back to the log; a new run clears plan and script
  // together. Every LLM run has a script from its first turn, the default; other policies never do.
  const scripted = battleScript?.source != null;
  const chosen: PaneTab = tab === 'script' && !scripted ? 'log' : tab;
  const planned = plan.some((version) => version.text.trim() !== '');
  const pane: PaneTab = chosen === 'plan' && !planned ? 'log' : chosen;
  const wins = useMemo(
    () => entries.filter((entry) => entry.type === 'agent' && entry.kind === 'hall_of_fame').length,
    [entries],
  );
  const moments = useMemo(() => entries.filter((entry) => entry.type === 'moment').length, [entries]);
  // What it is doing now, in the model's own words: the newest decision it explained.
  const now = useMemo(() => {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry.type === 'decision' && entry.narration) return entry.narration;
    }
    return null;
  }, [entries]);

  // `null` under every policy that is not an LLM.
  const player = status?.model ?? null;
  const game = `Pokémon ${gameName(status?.game_kind)}`;
  const opponent = status?.game?.opponent ?? null;

  // A background tab's title is its whole UI, so it names who is playing.
  useEffect(() => {
    document.title = describeTitle(player, status?.policy ?? null, game);
  }, [player, status?.policy, game]);

  const turns = useMemo(() => hasTurns(entries), [entries]);
  const right: PaneTab = pane === 'highlights' ? 'highlights' : 'log';

  return (
    <div className="app">
      <header className="topbar">
        <span className={`dot ${connection}`} title={connection === 'live' ? 'connected' : connection} />
        <span className="title">{game}</span>
        <span className="player" title={player ? `GB_MODEL=${player}` : `--policy ${status?.policy ?? ''}`}>
          {player ?? status?.policy ?? ''}
        </span>
        <span className={`run ${run.state}`} title={describeRun(run)}>
          {shortRun(run)}
        </span>
        <span className="spacer" />
        <SoundButton />
        <Menu>
          {(close) => (
            <>
              <div className="menu-item static">
                <span className="dim">played by</span>
                <span className="menu-player">{player ?? status?.policy ?? '…'}</span>
              </div>
              <div className="menu-item static">
                <span className="dim">now</span>
                <span>{describeRun(run)}</span>
              </div>
              {usage && (
                <div className="menu-item static" title={describeUsage(usage)}>
                  <span className="dim">context</span>
                  <span className="context">
                    <span className="gauge">
                      <span className="fill" style={{ width: `${occupancy(usage)}%` }} />
                    </span>
                    {Math.round(occupancy(usage))}%{usage.estimated ? '~' : ''} ·{' '}
                    {compactTokens(usage.prompt_tokens + usage.completion_tokens)} spent
                  </span>
                </div>
              )}
              <hr />
              <button
                className="menu-item"
                role="menuitem"
                onClick={() => {
                  setBoard(true);
                  close();
                }}
              >
                🏆 Hall of Fame
              </button>
              <button
                className="menu-item"
                role="menuitemcheckbox"
                aria-checked={raw}
                onClick={() => setRaw(!raw)}
                title="Show the JSON behind every card, exactly as it arrived on /api/events"
              >
                {'{}'} Raw events {raw ? '✓' : ''}
              </button>
              <hr />
              <a className="menu-item" role="menuitem" href="https://github.com/axle-h/poke-agent">
                <GitHubMark /> axle-h/poke-agent on GitHub
              </a>
              <a className="menu-item" role="menuitem" href="https://ax-h.com">
                <img className="face" src="/mugshot.png" alt="" width={20} height={20} /> ax-h.com
              </a>
            </>
          )}
        </Menu>
      </header>
      <Leaderboard wins={wins} open={board} onClose={closeBoard} />

      <main className={`tab-${pane}`}>
        <section className="left">
          <div className="stage">
            <Screen pausedUntil={run.state === 'throttled' ? run.until_ms : null} />
            {opponent && <Opponent opponent={opponent} />}
          </div>
          {/* Phone-only tabs. The buttons key off `pane`, not `tab`, so a fallback moves the highlight. */}
          <nav className="pane-tabs">
            <PaneButton pane={pane} value="log" onPick={setTab}>
              Log
            </PaneButton>
            <PaneButton pane={pane} value="status" onPick={setTab}>
              Trainer
            </PaneButton>
            <PaneButton pane={pane} value="highlights" onPick={setTab}>
              Highlights
            </PaneButton>
            {planned && (
              <PaneButton pane={pane} value="plan" onPick={setTab}>
                Plan
              </PaneButton>
            )}
            {scripted && (
              <PaneButton pane={pane} value="script" onPick={setTab}>
                Script
              </PaneButton>
            )}
          </nav>
          <StatusPanel status={status} speed={speed} now={now} />
          <PlanPanel plan={plan} onOlder={loadOlderPlans} />
          <BattleScriptPanel script={battleScript} alwaysOpen={pane === 'script'} />
        </section>
        <section className={`right show-${right}`}>
          <nav className="right-tabs">
            {/* Desk-only: the phone's tabs already choose this. */}
            <span className="desk">
              <PaneButton pane={right} value="log" onPick={setTab}>
                Log
              </PaneButton>
              <PaneButton pane={right} value="highlights" onPick={setTab}>
                Highlights
              </PaneButton>
            </span>
            <span className="spacer" />
            {right === 'log' && turns && (
              <span className="modes">
                <button
                  className={mode === 'story' ? 'on' : ''}
                  aria-pressed={mode === 'story'}
                  onClick={() => chooseMode('story')}
                  title="What the model decided and why, and the run's big moments"
                >
                  Story
                </button>
                <button
                  className={mode === 'everything' ? 'on' : ''}
                  aria-pressed={mode === 'everything'}
                  onClick={() => chooseMode('everything')}
                  title="Every file it read, every thought and every line the game printed"
                >
                  Everything
                </button>
              </span>
            )}
          </nav>
          <Conversation entries={entries} visible={right === 'log'} mode={mode} raw={raw} />
          {right === 'highlights' && <Highlights seen={moments} />}
        </section>
      </main>
    </div>
  );
}

function PaneButton({
  pane,
  value,
  onPick,
  children,
}: {
  pane: PaneTab;
  value: PaneTab;
  onPick: (pane: PaneTab) => void;
  children: string;
}) {
  return (
    <button className={pane === value ? 'on' : ''} aria-pressed={pane === value} onClick={() => onPick(value)}>
      {children}
    </button>
  );
}

function storedMode(): LogMode {
  try {
    return localStorage.getItem(LOG_MODE_KEY) === 'everything' ? 'everything' : 'story';
  } catch {
    return 'story';
  }
}

function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" width="20" height="20" aria-hidden="true">
      <path
        fill="currentColor"
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"
      />
    </svg>
  );
}

function occupancy(usage: UsageView): number {
  return Math.min(100, (100 * usage.context_tokens) / Math.max(1, usage.context_limit));
}

/** 128 400 tokens is `128k`. */
function compactTokens(tokens: number): string {
  if (tokens < 10_000) return `${tokens}`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

function describeUsage(usage: UsageView): string {
  const source = usage.estimated ? 'estimated, since the endpoint reports no usage' : 'reported by the endpoint';
  return [
    `${usage.context_tokens.toLocaleString()} of ${usage.context_limit.toLocaleString()} tokens in context`,
    `${usage.prompt_tokens.toLocaleString()} prompt + ${usage.completion_tokens.toLocaleString()} completion`,
    ...(usage.cache_read_tokens
      ? [`${Math.round((100 * usage.cache_read_tokens) / Math.max(usage.prompt_tokens, 1))}% of the prompt read from the cache`]
      : []),
    `over ${usage.completions.toLocaleString()} completions (${source})`,
  ].join('\n');
}

/** The tab title: the full `GB_MODEL`, or how the game is played under a policy with no model. */
function describeTitle(player: string | null, policy: string | null, game: string): string {
  if (player) return `${player} plays ${game}`;
  switch (policy) {
    case 'random':
      return `Randomly playing ${game}`;
    case 'console':
      return `Playing ${game} by hand`;
    case 'scripted':
      return `Scripted playthrough of ${game}`;
    // An unknown policy is a build newer than this page.
    default:
      return game;
  }
}

/** What the run is doing, in the fewest words that distinguish the cases. */
function describeRun(run: RunStatus): string {
  switch (run.state) {
    case 'booting':
      return 'booting';
    case 'playing':
      return 'playing';
    case 'awaiting_llm':
      return `thinking · ${run.kind}`;
    case 'streaming':
      return 'replying';
    case 'running_tool':
      return `tool · ${run.name}`;
    case 'compacting':
      return 'compacting context';
    case 'rate_limited':
      return `rate limited · retrying in ${Math.round(run.retry_in_ms / 100) / 10}s`;
    case 'throttled':
      return `endpoint refusing · paused for ${describeRemaining(run.until_ms - Date.now())}`;
    case 'error':
      return run.message;
  }
}

/** The header's one word; `describeRun` is its `title` and the menu's line. */
function shortRun(run: RunStatus): string {
  switch (run.state) {
    case 'awaiting_llm':
    case 'streaming':
    case 'running_tool':
      return 'thinking';
    case 'compacting':
      return 'compacting';
    case 'rate_limited':
      return 'rate limited';
    case 'throttled':
      return `paused ${describeRemaining(run.until_ms - Date.now())}`;
    case 'error':
      return 'error';
    default:
      return run.state;
  }
}
