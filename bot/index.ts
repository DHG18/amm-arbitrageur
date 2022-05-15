import { ethers } from 'hardhat';
import { BigNumber } from 'ethers';
import pool from '@ricokahler/pool';
import AsyncLock from 'async-lock';

import { FlashBot } from '../typechain/FlashBot';
import { Network, tryLoadPairs, getTokens } from './tokens';
import { getBnbPrice } from './basetoken-price';
import log from './log';
import config from './config';
import _ from 'lodash';
import { exit } from 'process';

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function calcNetProfit(profitWei: BigNumber, address: string, baseTokens: Tokens): Promise<number> {
  // returns profit in USD factoring in gas cost
  let price = 1;
  if (baseTokens.wbnb.address == address) {
    price = await getBnbPrice(); // probably for optimization purposes
  }
  let profit = parseFloat(ethers.utils.formatEther(profitWei));
  profit = profit * price;

  const gasCost = price * parseFloat(ethers.utils.formatEther(config.gasPrice)) * (config.gasLimit as number); // paying gas limit
  return profit - gasCost; // has to be greater than minProfit for us to do this trade
}

function arbitrageFunc(flashBot: FlashBot, baseTokens: Tokens) {
  const lock = new AsyncLock({ timeout: 2000, maxPending: 20 }); // ???
  
  return async function arbitrage(pair: ArbitragePair) {
    const [pair0, pair1] = pair.pairs; // pair of addresses

    let res: [BigNumber, string] & {
      profit: BigNumber;
      baseToken: string;
    }; // initializing profit as a number and baseToken as a string type
    
    try {
      res = await flashBot.getProfit(pair0, pair1); // returns what the profit would be for this pair
      log.debug(`Profit on ${pair.symbols}: ${ethers.utils.formatEther(res.profit)}`); // prints out profit
    } catch (err) {
      log.debug(err);
      return;
    }

    if (res.profit.gt(BigNumber.from('0'))) {
      const netProfit = await calcNetProfit(res.profit, res.baseToken, baseTokens);
      if (netProfit < config.minimumProfit) { // must be greater than our minimum profit (says $50 right now)
        return;
      }

      log.info(`Calling flash arbitrage, net profit: ${netProfit}`); // time to do the flash arb.
      try {
        // lock to prevent tx nonce overlap
        await lock.acquire('flash-bot', async () => {
          const response = await flashBot.flashArbitrage(pair0, pair1, {
            gasPrice: config.gasPrice,
            gasLimit: config.gasLimit,
          }); /// ??? where do they actually execute the flash swap on uni
          const receipt = await response.wait(1);
          log.info(`Tx: ${receipt.transactionHash}`);
        });
      } catch (err: any) {
        if (err.message === 'Too much pending tasks' || err.message === 'async-lock timed out') {
          return;
        }
        log.error(err);
      }
    }
  };
}

async function main() {
  const pairs = await tryLoadPairs(Network.BSC);
  console.log("Got the pairs");
  const flashBot = (await ethers.getContractAt('FlashBot', config.contractAddr)) as FlashBot;
  console.log("got flashBot"); // returns contract we can interact with (must deploy first)
  const [baseTokens] = getTokens(Network.BSC);
  console.log(baseTokens);
  // base Tokens:
  // {
  //   wbnb: {
  //     symbol: 'WBNB',
  //     address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'
  //   },
  //   usdt: {
  //     symbol: 'USDT',
  //     address: '0x55d398326f99059ff775485246999027b3197955'
  //   },
  //   busd: {
  //     symbol: 'BUSD',
  //     address: '0xe9e7cea3dedca5984780bafc599bd69add087d56'
  //   }
  // }

  log.info('Start arbitraging');
  while (true) { // infinite for loop
    await pool({ // performs the arbitrage function on all of the listed pairs, allowing for concurrency when doing so
      collection: pairs, // passes all pairs object
      task: arbitrageFunc(flashBot, baseTokens), // this is fucking dope! runs arb fun on each individual pair knowing base tokens
      // maxConcurrency: config.concurrency, ??? why is this commented out
    });
    await sleep(1000); // runs every 1000 seconds (I think it's seconds, no wifi atm)
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    log.error(err);
    process.exit(1);
  });
