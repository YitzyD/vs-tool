#!/usr/bin/env node
const VSClient = require("./client.js")
const colors = require('colors');
const util = require('util')
const storage = require('node-persist');
const prompts = require("prompts")
const xbytes = require('xbytes')
const fetch = require('node-fetch')
const { newVirtualServerManifest, k8sValidateQuantity } = require("./util.js")

const main = async() => {
  console.log("Let's create a new Virtual Server.".green)
  console.log("Loading...".green)
  await storage.init({
    dir: __dirname + '/vs-tool.cache',
    ttl: 10 * 60 * 1000, // TTL entries to 10 mins
  });
  const client = new VSClient()
  await client.init()
  const onCancel = (prompt) => {
    process.exit(0)
  }
  
  let images = await storage.getItem('images')
  if(!images) {
    images = await client.image.list({namespace: "vd-images"})
    .then(o => o.body.items)
    .then(images =>  
      Object.values(images.reduce((acc, i) => {
          const name = i.metadata.name
          const base = name.replace(/-\d*-(?!.*-\d*-)/, '-DATE-')
          const date = (name.match(/-\d*-(?!.*-\d*-)/) || [])[0]
          if (!acc[base] || date > acc[base][1]) {
            acc[base] = [i, date]
          }
          return acc
        }, {}))
      .map(i => i[0])
    )
    .then(images => storage.setItem('images', images))
    .then(() => storage.getItem('images'))
    .catch(_ => [])
  }

  let definitions = await storage.getItem('definitions')
  if(!definitions) {
    definitions = await client.definition.list({namespace: "virtual-server"})
    .then(o => o.body.items)
    .catch(_ => null)
    await storage.setItem('definitions', definitions)
  }

  let options = await storage.getItem('options')
  if(!options) {
    await fetch('https://www.coreweave.com/cloud/api/v1/metadata/instances')
    .then(r => r.json())
    .then(o => options = {
      gpuOptions: o.filter(v => v.type === 'gpu'), 
      cpuOptions: o.filter(v => v.type === 'cpu')
    })
    .then(() => storage.setItem('options', options))
  }
  const { 
    cpuOptions = [],
    gpuOptions = []
  } = options || {}

  const pvcs = await client.pvc.list().then(o => o.body.items)

  const basePrompts = [
    {
      type: 'text',
      name: 'name',
      message: 'Enter a name for your Virtual Server.',
      validate: v => /[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*/.test(v)
    },
    {
      type: 'text',
      name: 'namespace',
      initial: client.defaultNamespace,
      message: 'Enter the namespace to deploy your Virtual Server to.',
      validate: v => /[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*/.test(v)
    },
    {
      type: 'autocomplete',
      name: 'region',
      message: 'Select a region.',
      choices: [
        {title: "ORD1"},
        {title: "EWR1"},
      ]
    },
    {
      type: () => images.length > 0 ? 'autocomplete' : 'text',
      name: 'image',
      message: () => images.length > 0 ? 'Select an image.' : 'Enter source image PVC name for the root FS.',
      format: v => images.filter(i => i.metadata.name === v)[0],
      choices: images.length > 0 ? images.map(i => ({title: i.metadata.name})): null,
      validate: v => /[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*/.test(v)
    },
    {
      type: () => images.length > 0 ? null : 'text',
      name: 'imageNamespace',
      initial: client.defaultNamespace,
      message: 'Enter the namespace of the source PVC for the root FS.',
      validate: v => /[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*/.test(v)
    },
    {
      type: () => images.length > 0 ? null : 'text',
      name: "imageSize",
      initial: "40Gi",
      message: 'Enter root FS PVC size',
      validate: v => k8sValidateQuantity(v) || "Must be a valid quantity."
    },
    {
      type: () => images.length > 0 ? null : 'text',
      name: "imageStorageClassName",
      message: 'Enter root FS PVC storageClassName',
      validate: v => /[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*/.test(v)
    },
    {
      type: 'autocomplete',
      name: 'os',
      message: 'Select an OS.',
      initial: (_, values) => (!!values.image) ? (values.image.metadata.name.includes("windows") ? "windows" : "linux") : null,
      choices: [
        {title: "linux"},
        {title: "windows"},
      ]
    }
  ]

  resourcePrompts = [
    {
      type: () => (!!definitions) ? 'autocomplete' : 'text',
      name: 'definition',
      message: () => (!!definitions) ? 'Select a definition.' : 'Enter a definition.',
      validate: v => /[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*/.test(v),
      choices: (!!definitions) ? definitions.map(d => ({title: d.spec.alias})) : [],
      format: v => (!!definitions) ? definitions.filter(d => d.spec.alias === v)[0] : {spec: {alias: v} }
    },
    {
      type: 'toggle',
      name: 'systemType',
      active: 'true',
      inactive: 'false',
      message: 'Add a GPU?'
    },
    {
      type: (_, values) => values.systemType === true ? 'autocomplete' : null,
      name: 'gpu',
      message: 'Select a GPU.',
      choices: (_, values) => {
        return (!!definitions) 
        ? values.definition.spec.presets.filter(p => p.class === 'gpu').map(p => ({title: p.type}))
        : gpuOptions.map(v => ({title: v.id}))
      }
    },
    {
      type: (_, values) => (!!values.gpu) ? 'number' : null,
      name: 'gpuCount',
      initial: 1,
      min: 1,
      increment: 1,
      message: 'Select a number of GPU(s).'
    },
    {
      type: (_, values) => values.systemType ? null : 'autocomplete',
      name: 'cpu',
      message: 'Select a CPU.',
      choices: (_, values) => {
        return (!!definitions) 
        ? values.definition.spec.presets.filter(p => p.class === 'cpu').map(p => ({title: p.type}))
        : cpuOptions.map(v => ({title: v.id}))
      }
    },
    {
      type: 'number',
      initial: 1,
      min: 1,
      name: 'cpuCount',
      message: 'Select a number of CPU(s).'
    },
    {
      type: 'text',
      name: 'memory',
      message: 'Enter memory amount.',
      initial: "1Gi",
      validate: v => k8sValidateQuantity(v) || "Must be a valid quantity."
    },
    {
      type: 'toggle',
      name: 'addSwap',
      active: 'true',
      inactive: 'false',
      message: 'Add swap?'
    },
    {
      type: (_, values) => values.addSwap ? 'text' : null,
      name: 'swap',
      message: 'Enter swap amount.',
      initial: "1Gi",
      validate: v => k8sValidateQuantity(v) || "Must be a valid quantity."
    },
  ]

  const baseResponse = await prompts(basePrompts, {onCancel})
  const resouceResponse = await prompts(resourcePrompts, {onCancel})

  const services = await client.service.list({namespace: baseResponse.namespace}).then(o => o.body.items)

  let users = []
  for(i=0; (await prompts({
    type: 'toggle',
    name: 'addUser',
    active: 'true',
    inactive: 'false',
    message: `Add ${i === 0 ? "a" : "another"} User?`
  }, {onCancel})).addUser; i++) {
    userPrompts = [
      {
        type: 'text',
        name: 'username',
        message: 'Enter a username.',
        validate: v => users.every(u => u.username !== v) || "User already added."
      },
      {
        type: 'password',
        name: 'password',
        message: 'Enter a password.',
      }
    ]
    let cancelled = false
    const user = await prompts(userPrompts, {onCancel: () => cancelled = true})
    if(cancelled) break
    users = [...users, user]
  }

  networkPrompts = [
    {
      type: "toggle",
      name: "directAttach",
      active: "true",
      inactive: "false",
      message: "Direct attach load balancer?"
    },
    {
      type: (_, values) => values.directAttach ? null : "list",
      name: "tcpPorts",
      message: "Enter a list of tcp ports to expose.",
      format: v => v.filter(v => v !== '').map(v => parseInt(v)),
      validate: v => {
        const ps = v.split(',').filter(v => v !== '')
        return ps.length > 10 ? "Maximum of 10 ports"
        : ps.every(p => (pInt = parseInt(p), pInt !== NaN && pInt > 0 && pInt <= 65536)) || "Invalid port value. 0 > port <= 65536."
      }
    },
    {
      type: (_, values) => values.directAttach ? null : "list",
      name: "udpPorts",
      message: "Enter a list of udp ports to expose.",
      format: v => v.filter(v => v !== '').map(v => parseInt(v)),
      validate: v => {
        const ps = v.split(',').filter(v => v !== '')
        return ps.length > 10 ? "Maximum of 10 ports"
        : ps.every(p => (pInt = parseInt(p), pInt !== NaN && pInt > 0 && pInt <= 65536)) || "Invalid port value. 0 > port <= 65536."
      }
    },
    {
      type: "multiselect",
      name: "floatingIPs",
      instructions: false,
      hint: '- Space to select. Return to submit',
      message: "Select any number of floating IP services.",
      choices: services.map(s => s.metadata.name),
      format: v => v.map(v => services[v])
    },
    {
      type: (_, values) => values.directAttach || values.tcpPorts.length > 0 || values.udpPorts.length > 0 ? "toggle" : null,
      name: "public",
      active: "true",
      inactive: "false",
      message: "Create a public IP?",
    }
  ]

  const storagePrompts = [
    {
      type: "multiselect",
      name: "additionalFS",
      instructions: false,
      hint: '- Space to select. Return to submit',
      message: "Select any number of pvcs to be mounted as filesystems.",
      choices: pvcs.map(s => s.metadata.name),
      format: v => v.map(v => pvcs[v])
    }
  ]
  const networkResponse = await prompts(networkPrompts, {onCancel})
  // const storageResponse = await prompts(storagePrompts, {onCancel})

  const vs = buildVS({baseResponse, resouceResponse, users, networkResponse})
  const price = priceVS({options, vs})
  console.log(util.inspect(vs, false, null, true))
  if(!!price) { 
    console.log(`Your Virtual Server will cost approximately $${price}/hour on Coreweave Cloud.`.green)
  }
  const confirmVS = (await prompts({
    type: "toggle",
    name: "confirmVS",
    active: "yes",
    inactive: "no",
    message: "Please confirm the Virtual Server spec above."
  }, {onCancel})).confirmVS

  if(confirmVS) {
    let tryAgain = true
    while(tryAgain) {
      console.log(`Creating your Virtual Server: ${vs.metadata.namespace}/${vs.metadata.name}...`.green)
      await client.virtualServer.create(vs)
      .then(o => {
        if(o.statusCode === 201) {
          console.log("Virtual Server Created!".green)
          console.log(`Run kubectl -n ${vs.metadata.namespace} get vs ${vs.metadata.name} to check out your new Virtual Server`)
        } else {
          console.log(`An unknown error occured. Code: ${o.statusCode}`.red)
        } 
        tryAgain = false
       })
       .catch(async err => {
          console.log(`An error occured while creating the Virtual Server. ${err.message}`.red)
          tryAgain = await prompts({
            type: "toggle",
            name: "tryAgain",
            active: "yes",
            inactive: "no",
            message: "Try again?"
          }, {onCancel}).tryAgain
       })
    }
  }
}

const buildVS = ({
  baseResponse, 
  resouceResponse, 
  storageResponse, 
  users, 
  networkResponse
}) => {
  const virtualServerManifest = newVirtualServerManifest({
    name: baseResponse.name,
    namespace: baseResponse.namespace
  })
  virtualServerManifest.spec = {
    region: baseResponse.region,
    os: {
      type: baseResponse.os
    },
    resources: {
      definition: resouceResponse.definition.spec.alias,
      gpu: {
        type: resouceResponse.gpu,
        count: resouceResponse.gpuCount
      },
      cpu: {
        count: resouceResponse.cpuCount,
        type: resouceResponse.cpu
      },
      memory: resouceResponse.memory
    },
    storage: {
      root: {
        size: (!!baseResponse.image) ? baseResponse.image.spec.resources.requests.storage : baseResponse.imageSize,
        storageClassName: (!!baseResponse.image) ? baseResponse.image.spec.storageClassName : baseResponse.imageStorageClassName,
        source: {
          pvc: {
            namespace: (!!baseResponse.image) ? baseResponse.image.metadata.namespace : baseResponse.imageNamespace,
            name: (!!baseResponse.image) ? baseResponse.image.metadata.name : baseResponse.image,
          }
        }
      },
      swap: resouceResponse.swap
    },
    users,
    network: {
      public: networkResponse.public || false,
      tcp: {
        ports: networkResponse.tcpPorts
      },
      udp: {
        ports: networkResponse.udpPorts
      },
      floatingIPs: networkResponse.floatingIPs.map(f => ({serviceName: f.metadata.name}))
    },
    initializeRunning: true
  }
  return virtualServerManifest
}

const priceVS =({vs, options}) => {
  const option = (!!vs.spec.resources.gpu.type) 
  ? options.gpuOptions.filter(o => o.id === vs.spec.resources.gpu.type)[0]
  : options.cpuOptions.filter(o => o.id === vs.spec.resources.cpu.type)[0]
  if(!option) { return null }
  const gpuRate = (!!vs.spec.resources.gpu.type) ? option.gpu.billingRate * vs.spec.resources.gpu.count : 0
  const cpuRate = (!!vs.spec.resources.cpu.type) ? option.cpu.billingRate * vs.spec.resources.cpu.count : 0
  const memRate = option.cpu.memory.billingRate * xbytes.relative(xbytes.parseSize(vs.spec.resources.memory + (vs.spec.resources.memory.slice(-1) === 'b' ? '' : 'b'), {bits: false}), 'GB').parsed.value
  const storeRate = 0.000097 * xbytes.relative(xbytes.parseSize(vs.spec.storage.root.size + (vs.spec.storage.root.size.slice(-1) === 'b' ? '' : 'b'), {bits: false}), 'GB').parsed.value
  + ((!!vs.spec.storage.swap)
  ? 0.000097 * xbytes.relative(xbytes.parseSize(vs.spec.storage.swap + (vs.spec.storage.swap.slice(-1) === 'b' ? '' : 'b'), {bits: false}), 'GB').parsed.value
  : 0)

  return (gpuRate + cpuRate + memRate + storeRate).toFixed(2)
}

main()