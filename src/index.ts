import 'dotenv/config';
import path from 'path';
import {KeyvFile} from 'keyv-file';
import {getConfig} from './config.js';
import {QBittorrentClient} from './QBittorrentClient.js';
import {WindscribeClient, WindscribePort} from './WindscribeClient.js';
import {schedule} from 'node-cron';

// load config
const config = getConfig();

// init cache (if configured)
const cache = !config.cacheDir ? undefined : new KeyvFile({
  filename: path.join(config.cacheDir, 'cache.json'),
});

// inti windscribe client
const windscribe = new WindscribeClient(config.windscribeUsername, config.windscribePassword, cache);

// init torrent client
const client = new QBittorrentClient(config.clientUrl, config.clientUsername, config.clientPassword);

// init schedule if configured
const scheduledTask = !config.cronSchedule ? null :
  schedule(config.cronSchedule, () => run('schedule'), {scheduled: false});

async function update() {
  let nextRetry: Date = null;
  let nextRun: Date = null;

  let portInfo: WindscribePort;
  try {
    // try to update ephemeral port
    portInfo = await windscribe.updatePort();

    const windscribeExtraDelay = config.windscribeExtraDelay || (60 * 1000);
    nextRun = new Date(portInfo.expires.getTime() + windscribeExtraDelay);
  } catch (error) {
    console.error('Windscribe update failed: ', error);

    // if failed, retry after some delay
    const windscribeRetryDelay = config.windscribeRetryDelay || (60 * 60 * 1000);
    nextRetry = new Date(Date.now() + windscribeRetryDelay);

    // get cached info if available
    portInfo = await windscribe.getPort();
  }

  try {
    let currentPort = await client.getPort();
    if (portInfo) {
      if (currentPort == portInfo.port) {
        // no need to update
        console.log(`Current torrent port (${currentPort}) already matches windscribe port`);
      } else {
        // update port to a new one
        console.log(`Current torrent port (${currentPort}) does not match windscribe port (${portInfo.port})`);
        await client.updatePort(portInfo.port);

        // double check
        currentPort = await client.getPort();
        if (currentPort != portInfo.port) {
          throw new Error(`Unable to set torrent port! Current torrent port: ${currentPort}`);
        }
        console.log('torrent port updated');
      }
    } else {
      console.log(`Windscribe port is unknown, current torrent port is ${currentPort}`);
    }
  } catch (error) {
    console.error('torrent update failed', error);

    // if failed, retry after some delay
    const clientRetryDelay = config.clientRetryDelay || (5 * 60 * 1000);
    nextRetry = new Date(Date.now() + clientRetryDelay);
  }

  return {
    nextRun,
    nextRetry,
  };
}

let timeoutId: NodeJS.Timeout; // next run/retry timer
async function run(trigger: string) {
  console.log(`starting update, trigger type: ${trigger}`);

  // clear any previous timeouts (relevant when triggered by schedule)
  clearTimeout(timeoutId);

  // the magic
  const {nextRun, nextRetry} = await update().catch(error => {
    // in theory this should never throw, if it does we have bigger problems
    console.error(error);
    process.exit(1);
  });

  // reties always take priority since they block normal runs from the retry delay
  if (nextRetry) {
    // disable schedule if present
    scheduledTask?.stop();

    // calculate delay
    const delay = nextRetry.getTime() - Date.now();
    console.log(`Next retry scheduled for ${nextRetry.toLocaleString()} (in ${Math.floor(delay / 100) / 10} seconds)`);

    // set timer
    timeoutId = setTimeout(() => run('retry'), delay);
  } else if (nextRun) {
    // re-enable schedule if present
    scheduledTask?.start();

    // calculate delay
    const delay = nextRun.getTime() - Date.now();
    console.log(`Next normal run scheduled for ${nextRun.toLocaleString()} (in ${Math.floor(delay / 100) / 10} seconds)`);
    if (scheduledTask != null) {
      console.log('Cron schedule is configured, there might be runs happening sooner!');
    }

    // set timer
    timeoutId = setTimeout(() => run('normal'), delay);
  } else {
    // in theory this should never happen
    console.error('Invalid state, no next retry/run date present');
    process.exit(1);
  }
}

// always run on start
run('initial');
