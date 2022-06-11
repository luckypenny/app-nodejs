// global variables
const _PATH = global._PATH;
const logger = global.logger;

// Library
const moment = require('moment-timezone');
require('moment-timezone');
moment.tz.setDefault('Asia/Seoul');

// Consts
const _CONSTS = require('./src/consts/app_consts');
const { LOG_LEVEL } = require(`${_PATH.COMMON_ROOT}/modules/logger/_logger`);

// Config
const _APP_CONFIG = require('./src/_config');
// Utils
const g_print_utils = require(`${_PATH.COMMON_ROOT}/modules/utils/print_util`);
const g_common_utils = require(`${_PATH.COMMON_ROOT}/modules/utils/common_util`);

// Print Environment, App Paths, Consts
g_print_utils.infoBox(['Injected Environments', ...g_print_utils.layeredObjectToInfoBox(_APP_CONFIG)], LOG_LEVEL.DEBUG);
g_print_utils.infoBox(['App Paths', ...g_print_utils.layeredObjectToInfoBox(_PATH)], LOG_LEVEL.OFF);
g_print_utils.infoBox(['Consts', ...g_print_utils.layeredObjectToInfoBox(_CONSTS)], LOG_LEVEL.OFF);

const g_db_apis = require('./src/dbs/dbApis');

//  Cache
const g_proc_common_cache = require('./src/caches/procCommonCache');

// Redis Event PubSub
const RedisPubSub = require(`${_PATH.COMMON_ROOT}/modules/redis/RedisPubSub`);
let g_redis_pubsub = undefined;

let g_sync_tasks = new Array();
async function runTask() {
  if (g_sync_tasks.length > 0) {
    logger.debug(`Run Task...`);
    let _task = g_sync_tasks.pop();
    _task.task(..._task.args).then((result) => {
      _task.callback();
      runTask();
    });
  }
}

/*****************************************************
 * 초기화 코드
 *****************************************************/
/**
 * 초기화 코드
 */
async function init() {
  logger.info(`[init] ${_APP_CONFIG.APP.NAME} 초기화 시작`);
  // Redis 초기화
  await initRedis();

  // Contract 정보 초기화
  await initContract();

  // Broker 정보 Restore
  await restoreBrokers();
  await restoreBrokerContractMappingInfo();
}

/**
 * 레디스 초기화
 */
async function initRedis() {
  logger.info(`[init] ${_APP_CONFIG.APP.NAME} - Redis 초기화`);
  let _pubsub_redis_info = {
    redis_host: _APP_CONFIG.REDIS.PUBSUB.HOST,
    redis_port: _APP_CONFIG.REDIS.PUBSUB.PORT,
    redis_db: _APP_CONFIG.REDIS.PUBSUB.DATABASE,
  };
  g_redis_pubsub = new RedisPubSub(_pubsub_redis_info);
  await g_redis_pubsub.isReady();
  g_redis_pubsub.subscribe(
    [
      _CONSTS.APP.REDIS_MSG_EVENT.CHANNEL.L2BOOK.BROKER.PUB, // Broker 발신 메시지
      _CONSTS.APP.REDIS_MSG_EVENT.CHANNEL.FROM.CONTRACT,
    ],
    redisSubscribeMessageHandler,
  );
}

/**
 * Contract 정보 초기화
 */
async function initContract() {
  logger.info(`[init] ${_APP_CONFIG.APP.NAME} - 컨트렉트 초기화`);
  await g_db_apis.redis.getAllContracts().then((contracts) => {
    logger.debug(`[init] contract list : %o`, contracts);
    Object.keys(contracts).forEach(async (key) => {
      g_proc_common_cache.setContractInfo(JSON.parse(contracts[key]));
    });
  });
  logger.debug('[init] opend contract list : %o', g_proc_common_cache.getContractList());
}

/**
 * Broker 정보 복구
 */
async function restoreBrokers() {
  logger.info(`[init] ${_APP_CONFIG.APP.NAME} - Broker 리스트 복구`);
  let _broker_keys = await g_db_apis.redis.getBrokerKeys();
  logger.trace(`[init] _broker_keys : %o`, _broker_keys);

  let _promise_all = [];
  _broker_keys.forEach(async (key) => {
    logger.trace(`[init] _broker_info 조회`);
    _promise_all.push(
      new Promise(async (resolve, reject) => {
        let _broker_info = await g_db_apis.redis.getBrokerInfo(key);
        logger.trace(`[init] _broker_info : %o`, _broker_info);
        if (_broker_info.id === undefined) {
          _broker_info.id = key.replace(`${_CONSTS.APP.REDIS_KEYS.CASTER.L2BOOK_MGR.BROKER_LIST}:`, '');
          _broker_info.status = _CONSTS.BROKER.STATUS.INVALID;

          logger.warn(`[init] Invalid Broker Info : %o`, _broker_info);
        }
        g_proc_common_cache.addBroker(_broker_info);
        resolve(_broker_info);
      }),
    );
  });

  await Promise.all(_promise_all);

  logger.debug(`[init] g_proc_common_cache.getBrokerList() : %o`, g_proc_common_cache.getBrokerList());
}

/**
 * Broker Contract Info 복구
 */
async function restoreBrokerContractMappingInfo() {
  logger.info(`[init][restore] ${_APP_CONFIG.APP.NAME} - Broker Contract 맵 복구`);
  let _broker_contract_map_keys = await g_db_apis.redis.getBrokerContractInfoKeys();
  let _restore_broker_contract_map = new Map();
  _broker_contract_map_keys.forEach(async (key) => {
    let _is_invalid = false;

    // Broker Contract Mapping 정보 조회
    let _broker_contract_map = await g_db_apis.redis.getBrokerContractInfoByKey(key);
    logger.trace(`[init][restore] _contract_map_info : %o`, _broker_contract_map);

    // Broker 조회
    let _broker_info = g_proc_common_cache.getBrokerInfo(_broker_contract_map.broker_id);
    // Broker 정보가 존재하며, 상태값이 START|STOP이 아닌 경우
    if (_broker_info && [_CONSTS.BROKER.STATUS.START, _CONSTS.BROKER.STATUS.STOP].includes(_broker_info.status) === false) {
      // Broker Contract Mapping Validation
      // Broker Contract Mapping 정보에 Contract Symbol이 존재
      if (_broker_contract_map.symbol) {
        let _all_broker_ids = g_proc_common_cache.getBrokerIds();
        logger.trace(`[init][restore] _all_broker_ids : %o`, _all_broker_ids);
        // Broker Contract Mapping 정보의 Broker ID가 Broker List에 존재
        if (_all_broker_ids.includes(_broker_contract_map.broker_id)) {
          //
          if (_restore_broker_contract_map.has(_broker_contract_map.broker_id)) {
            _restore_broker_contract_map.get(_broker_contract_map.broker_id).push(_broker_contract_map);
          } else {
            _restore_broker_contract_map.set(_broker_contract_map.broker_id, [_broker_contract_map]);
          }
        } else {
          _is_invalid = true;
        }
      }
    } else {
      _is_invalid = true;
    }

    // Broker Contract Mapping 정보 이상시
    if (_is_invalid) {
      logger.error(`Contract Map Info Invalid Broker ID. %o`, _broker_contract_map);
      if (_broker_info) {
        await g_db_apis.redis.delBroker(_broker_info);
      }
      await g_db_apis.redis.delBrokerContractInfoByKey(key);
    }
  });

  let _result = await g_db_apis.redis.getAllBrokerContractInfo();
  logger.trace(`[init][restore] broker contract info result : %o`, _result);
  g_proc_common_cache.setBrokerContractMapList(_restore_broker_contract_map);
  logger.debug(`[init][restore] Broker-Contract Map Info : %o`, g_proc_common_cache.getBrokerContractMapList());
}

/*****************************************************
 * Redis Event 처리 코드
 *****************************************************/
/**
 * Caster Redis Publishing Message 수신 처리
 * @param {string} channel
 * @param {string} message
 */
async function redisSubscribeMessageHandler(channel, message) {
  let _payload = JSON.parse(message);
  logger.debug('[redis][sub] Channel : %o, payload : %o', channel, _payload);
  switch (_payload.action) {
    // L2Book Broker 상태 변경 이벤트
    case _CONSTS.APP.REDIS_MSG_EVENT.ACTION.L2BOOK.BROKER.STATUS: {
      await changedBrokerStatus({ req_id: _payload.req_id, broker_info: _payload.data });
      break;
    }
    // L2Book Broker 상태 변경 이벤트
    case _CONSTS.APP.REDIS_MSG_EVENT.ACTION.L2BOOK.BROKER.PING: {
      await receivedPing(_payload.data);
      break;
    }
    // Contract Config 변경
    case _CONSTS.APP.REDIS_MSG_EVENT.ACTION.CONTRACT.CONTRACT_CONFIG_UPDATE: {
      logger.debug('[redis][sub] contract config update');
      // Contract Info Cache 수정
      // 신규 Contract인 경우 Rebalancing
      await initContract();

      break;
    }
  }
}

/**
 * Broker Ping 메시지 처리
 * @param {object} ping Ping 발신 Broker 정보
 */
async function receivedPing(ping) {
  logger.trace(`[redis][sub] ping received : %o`, ping);
  g_proc_common_cache.setBrokerPingTime(ping.id);
}

/*****************************************************
 * Broker 관리 코드
 *****************************************************/
/**
 * Broker 정보 추가
 * @param {object} broker_info Broker 정보
 */
async function addBroker(broker_info) {
  logger.trace('[broker][add] g_proc_common_cache.hasBroker(broker_info) : %o', g_proc_common_cache.hasBroker(broker_info));

  if (false === g_proc_common_cache.hasBroker(broker_info)) {
    logger.trace('[broker][add] Add broker : %o', broker_info.id);
    g_proc_common_cache.addBroker(broker_info);
    await g_db_apis.redis.setBroker(broker_info);
    logger.trace('[broker][add] Add Broker ~>  %o', g_proc_common_cache.getBrokerList());
  }
}
/**
 * Broker 정보 삭제
 * @param {object} broker_info Broker 정보
 */
async function delBroker(broker_info) {
  logger.trace('[broker][del] g_proc_common_cache.hasBroker(broker_info) : %o', g_proc_common_cache.hasBroker(broker_info));
  if (true === g_proc_common_cache.hasBroker(broker_info)) {
    logger.trace('[broker][del] Delete broker : %o', broker_info.id);
    g_proc_common_cache.removeBroker(broker_info);
    await g_db_apis.redis.delBroker(broker_info);

    let _broker_contract_map = g_proc_common_cache.getBrokerContractMapByBroker(broker_info);
    if (_broker_contract_map) {
      _broker_contract_map.forEach((contract) => {
        g_db_apis.redis.delBrokerContractInfo(contract.symbol);
        g_proc_common_cache.removeBrokerContractMap(broker_info);
      });
    }

    logger.trace('[broker][del] Del Broker ~>  %o', g_proc_common_cache.getBrokerList());
  }
}

/**
 * Broker 정보 수정
 * @param {object} broker_info Broker 정보
 */
async function updateBrokerStatus(broker_info) {
  let _broker_info = g_proc_common_cache.getBrokerInfo(broker_info.id);
  _broker_info.status = broker_info.status;
  await g_db_apis.redis.setBroker(broker_info);
  logger.trace('[broker][mod] Update Broker ~>  %o', g_proc_common_cache.getBrokerList());
}

/**
 * Broker 상태값 변경
 * @param {object} param0
 */
async function changedBrokerStatus({ req_id, broker_info }) {
  let _current_time = new Date().getTime();
  switch (broker_info.status) {
    // L2Book Broker 시작
    case _CONSTS.BROKER.STATUS.START: {
      logger.warn(
        `[broker][status] BROKER_START - id : %o, at ${moment(Number(_current_time)).format('YYYY-MM-DD HH:mm:ss')})`,
        broker_info.id,
      );

      // broker_id가 존재 시 스킵,(중복방지)
      g_sync_tasks.push({
        task: addBroker,
        args: [broker_info],
        callback: () => {
          publishBrokerResponse({
            id: broker_info.id,
            req_id: req_id,
            result: true,
            result_code: 'STATUS_START_OK',
          });
        },
      });
      break;
    }
    // L2Book Broker 대기중
    case _CONSTS.BROKER.STATUS.WAIT: {
      logger.warn(
        `[broker][status] BROKER_WAIT - id : %o, at ${moment(Number(_current_time)).format('YYYY-MM-DD HH:mm:ss')})`,
        broker_info.id,
      );
      updateBrokerStatus(broker_info).then(() => {
        publishBrokerResponse({
          id: broker_info.id,
          req_id: req_id,
          result: true,
          result_code: 'STATUS_WAIT_OK',
        });
      });
      break;
    }
    // L2Book Broker 동작중
    case _CONSTS.BROKER.STATUS.RUN: {
      logger.warn(
        `[broker][status] BROKER_RUN - id : %o, at ${moment(Number(_current_time)).format('YYYY-MM-DD HH:mm:ss')})`,
        broker_info.id,
      );

      break;
    }
    // L2Book Broker 정지
    case _CONSTS.BROKER.STATUS.STOP: {
      logger.warn(
        `[broker][status] BROKER_STOP - id : %o, at ${moment(Number(_current_time)).format('YYYY-MM-DD HH:mm:ss')})`,
        broker_info.id,
      );
      await delBroker(broker_info);

      break;
    }
  }
}

/**
 * Broker Health 확인
 */
async function checkBrokerAlive() {
  logger.trace(`[broker][health] Checking Broker Alive`);

  g_proc_common_cache.getBrokerArray().forEach((broker_info) => {
    if (new Date().getTime() - broker_info.last_ping_time > _APP_CONFIG.APP.TIME_INTERVAL.PING_WAIT_TIMEOUT) {
      logger.warn(
        `[broker][health] PING_TIMEOUT - id :%o, last_ping_time : %o at ${moment(Number(broker_info.last_ping_time)).format(
          'YYYY-MM-DD HH:mm:ss',
        )})`,
        broker_info.id,
        broker_info.last_ping_time,
      );
      // Publish to Broker PING_TIMEOUT
      publishBrokerRemovedByTimeout(broker_info);
      // Delete Broker
      delBroker(broker_info);
    }
  });
}

/**
 * Rebalancing Check
 * - Contract Map의 Broker 리스트와 현재 Broker List를 비교하여 Rebalancing 여부 체크
 */
async function checkRebalancing() {
  logger.trace(`[rebalance] Check Rebalancing...`);
  let _run_rebalance_yn = false;
  // 현재 Rebalancing 중인 경우 스킵
  if (g_proc_common_cache.isRebalancing()) {
    logger.trace(`[rebalance] Rebalancing 진행중...`);
    return;
  }

  let _current_brokers_map = g_proc_common_cache.getBrokerList();
  let _all_broker_id_array = Array.from(_current_brokers_map.values())
    // .filter((broker_info) => broker_info.status !== _CONSTS.BROKER.STATUS.START && broker_info.status !== _CONSTS.BROKER.STATUS.STOP)
    .filter((broker_info) => [_CONSTS.BROKER.STATUS.START, _CONSTS.BROKER.STATUS.STOP].includes(broker_info.status) === false)
    .map((broker_info) => broker_info.id);

  // let _all_broker_id_array = g_proc_common_cache.getBrokerIds();
  logger.trace(`[rebalance] _all_broker_id_array : %o`, _all_broker_id_array);

  // 전체 Contract List
  let _open_contract_list = g_proc_common_cache.getContractSymbolList();
  // 현재 할당 완료된 Contract List
  let _assigned_contract_list = g_proc_common_cache.getAssignedContractSymbolList();

  // Broker 변동 여부 체크
  if (_all_broker_id_array.length > 0) {
    let _assigned_broker_id_array = g_proc_common_cache.getBrokerIdsFromBrokerContractMap();
    // Broker 리스트 변동 여부 체크
    logger.trace(`[rebalance] _all_broker_id_array.length : %o`, _all_broker_id_array.length);
    logger.trace(`[rebalance] _assigned_broker_id_array.length : %o`, _assigned_broker_id_array.length);
    if (_all_broker_id_array.length !== _assigned_broker_id_array.length) {
      if (_open_contract_list.length > _assigned_broker_id_array.length) {
        logger.trace(`[rebalance] Avail Broker 와 Assigned Broker 수 가 다름`);
        _run_rebalance_yn = true;
      }
    } else {
      // Broker의 Id 비교
      if (_all_broker_id_array.filter((x) => _assigned_broker_id_array.includes(x)).length !== _all_broker_id_array.length) {
        logger.trace(`[rebalance] Avail Broker 와 Assigned Broker의 Broker Id 다름`);
        _run_rebalance_yn = true;
      }
    }
  } else if (0 === _all_broker_id_array.length) {
    logger.error(`[rebalance] NONE_AVAIL_BROKERS`);
    return;
  }

  // Contract 변동 여부 체크
  logger.trace(`[rebalance] _assigned_contract_list : %o`, _assigned_contract_list);
  if (_open_contract_list.length > 0) {
    logger.trace(`[rebalance] _open_contract_list.length : %o`, _open_contract_list.length);
    logger.trace(`[rebalance] _assigned_contract_list.length : %o`, _assigned_contract_list.length);
    if (_open_contract_list.length !== _assigned_contract_list.length) {
      logger.trace(`[rebalance] Open Contract 와 Assigned Contract 다름`);
      _run_rebalance_yn = true;
    } else {
      // Contract Symbol 비교

      if (_open_contract_list.filter((x) => !_assigned_contract_list.includes(x)).length > 0) {
        logger.trace(`[rebalance] Open Contract 와 Assigned Contract의 Symbol이 다름`);
        _run_rebalance_yn = true;
      }
    }
  } else {
    logger.error(`[rebalance] NONE_OPENED_CONTRACTS`);
    return;
  }

  if (_run_rebalance_yn) {
    logger.info(`[rebalance] Rebalancing 시작.`);
    await rebalancingBrokers();
  }
}

/**
 * Broker에 심볼 재배치
 *  1) broker의 추가/삭제 발생시
 *  2) contract의 변경이 발생시
 *   - Contract New/Expire/Open
 */
async function rebalancingBrokers() {
  logger.trace('[rebalance] Rebalancing...');

  // 모든 컨트렉트 정보 조회
  let _current_contracts = g_proc_common_cache.getContractList();
  logger.debug(`[rebalance] _current_contracts : %o`, _current_contracts);

  if (undefined === _current_contracts || 0 === Object.keys(_current_contracts).length) {
    logger.error(`[rebalance] NONE_CONTRACTS`);
    return;
  }

  // 모든 브로커 정보 조회
  let _current_brokers_list = g_proc_common_cache.getBrokerList();
  logger.debug(`[rebalance] _current_brokers_list : %o`, _current_brokers_list);

  if (undefined === _current_brokers_list || 0 === _current_brokers_list.size) {
    logger.error(`[rebalance] NONE_BROKER`);
    return;
  }
  // 현재 가용가능한 Broker 리스트 생성(Broker.status !== START|STOP)
  let _avail_broker_list = Array.from(_current_brokers_list.values()).filter(
    (broker_info) => broker_info.status !== _CONSTS.BROKER.STATUS.START && broker_info.status !== _CONSTS.BROKER.STATUS.STOP,
  );

  logger.debug(`[rebalance] _avail_broker_list : %o`, _avail_broker_list);

  if (0 === _avail_broker_list.length) {
    logger.error(`[rebalance] NONE_AVAIL_BROKERS`);
    return;
  }
  // Rebalancing 진행중 표시
  g_proc_common_cache.startRebalancing();

  // 가용 가능한 Broker에 Contract 맵핑
  let _broker_index = 0;
  let _broker_contract_map = new Map();

  Object.keys(_current_contracts).forEach((key) => {
    let _broker_id = _avail_broker_list[_broker_index].id;
    logger.trace(`[rebalance] _broker_id : %o`, _broker_id);
    let _contract = _current_contracts[key];
    logger.trace(`[rebalance] _contract : %o `, _contract);
    if (_broker_contract_map.has(_broker_id)) {
      _broker_contract_map.get(_broker_id).push(_contract);
    } else {
      _broker_contract_map.set(_broker_id, [_contract]);
    }
    if (_broker_index === _avail_broker_list.length - 1) {
      _broker_index = 0;
    } else {
      _broker_index++;
    }
    g_db_apis.redis.delBrokerContractInfo(key).then(() => {
      g_db_apis.redis.setBrokerContractInfo(key, _broker_id);
    });
  });

  logger.debug(`[rebalance] _broker_contract_map : %o`, _broker_contract_map);
  g_proc_common_cache.setBrokerContractMapList(_broker_contract_map);

  // Rebalancing 메시지 전송
  publishBrokerRebalance();

  // publishBrokerRebalance(broker_info, active_list, inactive_list);
  g_proc_common_cache.stopRebalancing();
}

/*****************************************************
 * Manager Redis Event 발신 코드
 *****************************************************/
/**
 * Broker Rebalance Event 발신
 * @returns
 */
async function publishBrokerRebalance() {
  // Publish Broker Rebalanced
  logger.debug(`[redis][pub] rebalance - Publish Rebalanced event`);
  logger.trace(
    `[redis][pub] rebalance - g_proc_common_cache.getBrokerContractMapList() : %o`,
    g_proc_common_cache.getBrokerContractMapList(),
  );
  let _data = JSON.stringify(Object.fromEntries(g_proc_common_cache.getBrokerContractMapList()));
  logger.trace(`[redis][pub] rebalance - _data : %o`, _data);
  let _payload = {
    action: _CONSTS.APP.REDIS_MSG_EVENT.ACTION.L2BOOK.MGR.REBALANCED,
    data: _data,
  };
  logger.trace(`[redis][pub] rebalance - _payload : %o`, _payload);
  return g_redis_pubsub.publish(_CONSTS.APP.REDIS_MSG_EVENT.CHANNEL.L2BOOK.MGR.PUB, _payload);
}

/**
 * Ping Timeout으로 인하여 Broker 삭제 메시지 전송
 * @returns
 */
async function publishBrokerRemovedByTimeout(broker_info) {
  logger.debug(`[redis][pub] ping-timeout - Publish Ping Timeout event`);
  let _payload = {
    action: _CONSTS.APP.REDIS_MSG_EVENT.ACTION.L2BOOK.MGR.PING_TIMEOUT,
    data: {
      id: broker_info.id,
    },
  };
  logger.trace(`[redis][pub] ping-timeout - _payload : %o`, _payload);
  return g_redis_pubsub.publish(_CONSTS.APP.REDIS_MSG_EVENT.CHANNEL.L2BOOK.MGR.PUB, _payload);
}

/**
 * Broker Request에 대한 처리 결과 Response
 * @param {object} result
 * @returns
 */
async function publishBrokerResponse(result) {
  logger.debug(`[redis][pub] task-response - Publish Response event`);
  let _payload = {
    action: _CONSTS.APP.REDIS_MSG_EVENT.ACTION.L2BOOK.MGR.TASK_RESULT,
    data: result,
  };
  logger.trace(`[redis][pub] task-response - _payload : %o`, _payload);
  return g_redis_pubsub.publish(_CONSTS.APP.REDIS_MSG_EVENT.CHANNEL.L2BOOK.MGR.PUB, _payload);
}

/*****************************************************
 * Main 코드
 *****************************************************/
/**
 * Main
 * @returns {Promise<void>}
 */
async function main() {
  await init();

  g_common_utils.intervalRun(checkBrokerAlive, _APP_CONFIG.APP.TIME_INTERVAL.CHECK_PING_INTERVAL);
  // g_common_utils.intervalRun(callRebalancingBrokersTest, 1000);

  g_common_utils.intervalRun(checkRebalancing, _APP_CONFIG.APP.TIME_INTERVAL.CHECK_REBALANCE_INTERVAL);
  g_common_utils.intervalRun(runTask, 100);
}

/*****************************************************
 * Process 종료 코드
 *****************************************************/
/**
 *  Redis Connection 종료
 */
async function closeRedis() {
  logger.warn(`[shutdown] Redis Connection 종료`);
  let _promise_all = [];

  if (g_db_apis.redis.isReady()) {
    _promise_all.push(g_db_apis.redis.close());
  }
  if (g_redis_pubsub) {
    _promise_all.push(g_redis_pubsub.close());
  }

  return Promise.all(_promise_all);
}

/**
 * App 종료
 */
async function gracefulShutdown(type) {
  g_proc_common_cache.startTerminating();

  await closeRedis();
  process.exit();
}

/**
 * 비정상 종료시 처리
 */
// const g_signal_traps = ['SIGTERM', 'SIGINT', 'SIGUSR2', 'unhandledRejection', 'uncaughtException'];
const g_signal_traps = ['SIGTERM', 'SIGINT', 'SIGUSR2'];
g_signal_traps.map(async (type) => {
  //  await gracefulShutdown(type);
  process.on(type, async () => {
    if (!g_proc_common_cache.isTerminating()) {
      logger.error(`[shutdown] 시그널 [ ${type} ] 발생`);
      await gracefulShutdown(type);
    }
  });
});
module.exports.main = main;
