// TODO: agregar el archivo .dotenv
require("dotenv").config();
const Web3 = require('web3');
// traemos estos metodos del sdk de uniswap

const { ChainId, Fetcher, TokenAmount } = require('@uniswap/sdk');
// Aquí nos traemos los abis de los exchanges, solo traemos el de Kyber
const abis = require('./abis');
// Aquí nos traemos todas las addresses 0x... de todos los contraros que ocupamos
// Los de las tokens, Uniswap y Kyber
const { mainnet: addresses } = require('./addresses');
// Y nuestro querido flashloan smart contract // El que esta en build
const Flashloan = require('./build/contracts/Flashloan.json');

const web3 = new Web3(
  // Ponemos el Provider para inicializar web 3
  new Web3.providers.WebsocketProvider(process.env.INFURA_URL)
);

// Aquī ponemos el address del admin - osea la mía
// The web3.eth.accounts contains functions to generate Ethereum accounts and sign transactions and data.
// https://web3js.readthedocs.io/en/v1.2.11/web3-eth-accounts.html
const { address: admin } = web3.eth.accounts.wallet.add(process.env.PRIVATE_KEY);

// Inicializamos el contracto de Kyber
const kyber = new web3.eth.Contract(
  abis.kyber.kyberNetworkProxy,
  addresses.kyber.kyberNetworkProxy
);

const ONE_WEI = web3.utils.toBN(web3.utils.toWei('1'));
// El amount en Dai que queremos usar, expresados en wei
const AMOUNT_DAI_WEI = web3.utils.toBN(web3.utils.toWei('20000'));
const DIRECTION = {
  KYBER_TO_UNISWAP: 0,
  UNISWAP_TO_KYBER: 1
};

const init = async () => {
  // Contains functions to get information about the current network.
  // https://web3js.readthedocs.io/en/v1.2.11/web3-eth-net.html
  const networkId = await web3.eth.net.getId();
  const flashloan = new web3.eth.Contract(
    Flashloan.abi,
    Flashloan.networks[networkId].address
  );
  
  // All the app uses this variable, we get It from Kyber
  let ethPrice;
  // Here we are getting the expected rate of ETH in dai
  const updateEthPrice = async () => {
    const results = await kyber
      .methods
      .getExpectedRate(
        // https://developer.kyber.network/docs/TradingAPIGuide/
        // according to kyber, this is the ETH address, but we can update to any other token
        '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', 
        addresses.tokens.dai, 
        1
      )
      .call();

    // Here we do the necessary conversion to have a readable ETH price
    ethPrice = web3.utils.toBN('1').mul(web3.utils.toBN(results.expectedRate)).div(ONE_WEI);
  }
  await updateEthPrice();
  // Actualizamos la variable ethPrice cada 15 segundos
  setInterval(updateEthPrice, 15000);


  // newBlockHeaders es un de la blockchain, vamos a escuchar cuando llega cada bloque
  // https://web3js.readthedocs.io/en/v1.2.11/web3-eth-subscribe.html#subscribe-newblockheaders
  web3.eth.subscribe('newBlockHeaders')
    .on('data', async block => {
      console.log(`New block received. Block # ${block.number}`);

      // ----------------------------------------
      // Instanciamos dai y weth! ---
      // cada vez que hay un bloque nuevo ---
      // ----------------------------------------
      // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/all
      const [dai, weth] = await Promise.all(
        // Entre los tokens tenia weth también
        [addresses.tokens.dai, addresses.tokens.weth].map(tokenAddress => (
          // https://docs.uniswap.org/sdk/2.0.0/reference/fetcher#fetchtokendata
          Fetcher.fetchTokenData (
            ChainId.MAINNET,
            tokenAddress,
          )
      )));
      // https://docs.uniswap.org/sdk/2.0.0/reference/fetcher
      const daiWeth = await Fetcher.fetchPairData ( dai, weth );


      // How much eth we can get from our ETH?
      const amountsEth = await Promise.all([
        kyber
          .methods
          .getExpectedRate(
            addresses.tokens.dai, 
            '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', 
            AMOUNT_DAI_WEI
          ) 
          .call(),
        daiWeth.getOutputAmount(new TokenAmount(dai, AMOUNT_DAI_WEI)),
      ]);
      // This set how much ETH I can get for the amount of DAI I want to use from both exchanges
      const ethFromKyber = AMOUNT_DAI_WEI.mul(web3.utils.toBN(amountsEth[0].expectedRate)).div(ONE_WEI);
      const ethFromUniswap = web3.utils.toBN(amountsEth[1][0].raw.toString());

      // How much eth we can get from our DAI?
      const amountsDai = await Promise.all([
        kyber
          .methods
          .getExpectedRate(
            '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', 
            addresses.tokens.dai, 
            ethFromUniswap.toString()
          ) 
          .call(),
        daiWeth.getOutputAmount(new TokenAmount(weth, ethFromKyber.toString())),
      ]);
      // This set how much DAI I can get for the amount of ETH we are getting in the exchanges in the previous operation!
      const daiFromKyber = ethFromUniswap.mul(web3.utils.toBN(amountsDai[0].expectedRate)).div(ONE_WEI);
      const daiFromUniswap = web3.utils.toBN(amountsDai[1][0].raw.toString());

      // Display the message of the information we retreived
      console.log(`Kyber -> Uniswap. Dai input / output: ${web3.utils.fromWei(AMOUNT_DAI_WEI.toString())} / ${web3.utils.fromWei(daiFromUniswap.toString())}`);
      console.log(`Uniswap -> Kyber. Dai input / output: ${web3.utils.fromWei(AMOUNT_DAI_WEI.toString())} / ${web3.utils.fromWei(daiFromKyber.toString())}`);


      // ----------------------------------------
      // Hacemos la validación 
      // para ver si nos sirve hacer la opeaciòn
      // ----------------------------------------
      if(daiFromUniswap.gt(AMOUNT_DAI_WEI)) {
        const tx = flashloan.methods.initiateFlashloan(
          // The lending comes from dydx.solo
          // https://legacy-docs.dydx.exchange/#solo-protocol
          addresses.dydx.solo, 
          addresses.tokens.dai, 
          AMOUNT_DAI_WEI,
          // Comprar de KYBER_TO_UNISWAP
          DIRECTION.KYBER_TO_UNISWAP
        );
        const [gasPrice, gasCost] = await Promise.all([
          // https://web3js.readthedocs.io/en/v1.2.11/web3-eth.html#getgasprice
          web3.eth.getGasPrice(),
          // Here we use my private key
          tx.estimateGas({from: admin}),
        ]);

        // Transaction cost and "possible" profit
        const txCost = web3.utils.toBN(gasCost).mul(web3.utils.toBN(gasPrice)).mul(ethPrice);
        const profit = daiFromUniswap.sub(AMOUNT_DAI_WEI).sub(txCost);

        // Validamos si el profit nos sirve
        if(profit > 0) {
          console.log('Arb opportunity found Kyber -> Uniswap!');
          console.log(`Expected profit: ${web3.utils.fromWei(profit)} Dai`);
          // Is the method initiateFlashloan
          const data = tx.encodeABI();
          const txData = {
            from: admin,
            to: flashloan.options.address,
            data,
            gas: gasCost,
            gasPrice
          };
          // Basicamente en esta linea iniciamos el contrato, solo mandandole el gas
          // Ojo! no le mandamos nada más de dinero al contracto, solo el gas
          // https://web3js.readthedocs.io/en/v1.2.11/web3-eth.html#sendtransaction
          const receipt = await web3.eth.sendTransaction(txData);
          console.log(`Transaction hash: ${receipt.transactionHash}`);
        }
      }

      // ----------------------------------------
      // The same beauty that is explainned above 
      // but the other way around
      // ----------------------------------------
      if(daiFromKyber.gt(AMOUNT_DAI_WEI)) {
        const tx = flashloan.methods.initiateFlashloan(
          addresses.dydx.solo, 
          addresses.tokens.dai, 
          AMOUNT_DAI_WEI,
          DIRECTION.UNISWAP_TO_KYBER
        );
        const [gasPrice, gasCost] = await Promise.all([
          web3.eth.getGasPrice(),
          tx.estimateGas({from: admin}),
        ]);
        const txCost = web3.utils.toBN(gasCost).mul(web3.utils.toBN(gasPrice)).mul(ethPrice);
        const profit = daiFromKyber.sub(AMOUNT_DAI_WEI).sub(txCost);

        if(profit > 0) {
          console.log('Arb opportunity found Uniswap -> Kyber!');
          console.log(`Expected profit: ${web3.utils.fromWei(profit)} Dai`);
          const data = tx.encodeABI();
          const txData = {
            from: admin,
            to: flashloan.options.address,
            data,
            gas: gasCost,
            gasPrice
          };
          const receipt = await web3.eth.sendTransaction(txData);
          console.log(`Transaction hash: ${receipt.transactionHash}`);
        }
      }
    })
    .on('error', error => {
      console.log(error);
    });
}
init();
