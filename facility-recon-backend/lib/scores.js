const winston = require('winston');
const async = require('async');
const request = require('request');
const URI = require('urijs');
const levenshtein = require('fast-levenshtein');
const geodist = require('geodist');
const _ = require('underscore');
const config = require('./config');
const mcsd = require('./mcsd')();

var redis = require("redis"),
  client = redis.createClient({
    host: process.env.REDIS_HOST || '127.0.0.1'
  });

module.exports = function () {
  return {
    getJurisdictionScore(mcsdSource1, mcsdSource2, mcsdMapped, mcsdSource2All, mcsdSource1All, source1DB, source2DB, recoLevel, totalLevels, clientId, callback) {
      const scoreRequestId = `scoreResults${clientId}`
      const scoreResults = [];
      const matchBrokenCode = config.getConf('mapping:matchBrokenCode');
      const maxSuggestions = config.getConf('matchResults:maxSuggestions');
      if (mcsdSource2.total == 0) {
        winston.error('No Source2 data found for this orgunit');
        return callback();
      }
      if (mcsdSource1.total == 0) {
        winston.error('No Source1 data found');
        return callback();
      }
      let count = 0;
      var ignore = []
      var source2ParentNames = {}
      var source2MappedParentIds = {}
      winston.info('Populating parents')
      
      var totalRecords = mcsdSource2.entry.length
      for (entry of mcsdSource2.entry) {
        if (entry.resource.hasOwnProperty('partOf')) {
          source2ParentNames[entry.resource.id] = [];
          source2MappedParentIds[entry.resource.id] = [];
          var entityParent = entry.resource.partOf.reference;
          mcsd.getLocationParentsFromData(entityParent, mcsdSource2All, 'all', (parents) => {
            // lets make sure that we use the mapped parent for comparing against Source1
            async.each(parents, (parent, parentCallback) => {
              this.matchStatus(mcsdMapped, parent.id, (mapped) => {
                if (mapped) {
                  mapped.resource.identifier.find((identifier) => {
                    if (identifier.system == 'https://digitalhealth.intrahealth.org/source1') {
                      const source1ParId = identifier.value.split('/').pop();
                      source2MappedParentIds[entry.resource.id].push(source1ParId);
                    }
                  });
                  source2ParentNames[entry.resource.id].push(parent.text);
                } else {
                  source2MappedParentIds[entry.resource.id].push(parent.id);
                  source2ParentNames[entry.resource.id].push(parent.text);
                }
                parentCallback()
              });
            }, () => {
              count++
              let percent = parseFloat((count * 100 / totalRecords).toFixed(2))
              const scoreRequestId = `scoreResults${clientId}`
              scoreResData = JSON.stringify({
                status: '2/3 - Scanning Source2 Location Parents',
                error: null,
                percent: percent
              })
              redisClient.set(scoreRequestId, scoreResData)
              if (count === mcsdSource2.entry.length) {
                winston.info('Done populating parents')
              }
            })
          });
        }
      }
      mcsdSource2All = {}
      winston.info('Calculating scores now')
      count = 0
      var totalRecords = mcsdSource1.entry.length
      async.eachSeries(mcsdSource1.entry, (source1Entry, source1Callback) => {
        // check if this Source1 Orgid is mapped
        const source1Id = source1Entry.resource.id;
        const source1Identifier = URI(config.getConf('mCSD:url'))
          .segment(source1DB)
          .segment('fhir')
          .segment('Location')
          .segment(source1Id)
          .toString();
        var matchBroken = false
        if (source1Entry.resource.hasOwnProperty('tag')) {
          var matchBrokenTag = source1Entry.resource.tag.find((tag) => {
            return tag.code == matchBrokenCode
          })
          if (matchBrokenTag) {
            matchBroken = true
          }
        }
        this.matchStatus(mcsdMapped, source1Identifier, (match) => {
          // if this Source1 Org is already mapped
          if (match) {
            const noMatchCode = config.getConf('mapping:noMatchCode');
            var entityParent = null;
            if (source1Entry.resource.hasOwnProperty('partOf')) {
              entityParent = source1Entry.resource.partOf.reference;
            }
            mcsd.getLocationParentsFromData(entityParent, mcsdSource1All, 'names', (source1Parents) => {
              const thisRanking = {};
              thisRanking.source1 = {
                name: source1Entry.resource.name,
                parents: source1Parents,
                id: source1Entry.resource.id,
              };
              thisRanking.potentialMatches = {};
              thisRanking.exactMatch = {};
              let noMatch = null;
              if (match.resource.hasOwnProperty('tag')) {
                noMatch = match.resource.tag.find(tag => tag.code == noMatchCode);
              }
              // in case this is marked as no match then process next Source1
              if (noMatch) {
                thisRanking.source1.tag = 'noMatch';
                scoreResults.push(thisRanking);
                count++;
                let percent = parseFloat((count * 100 / totalRecords).toFixed(2))
                scoreResData = JSON.stringify({
                  status: '3/3 - Running Automatching',
                  error: null,
                  percent: percent
                })
                redisClient.set(scoreRequestId, scoreResData)
                return source1Callback();
              }
              // if no macth then this is already marked as a match

              const flagCode = config.getConf('mapping:flagCode');
              if (match.resource.hasOwnProperty('tag')) {
                const flag = match.resource.tag.find(tag => tag.code == flagCode);
                if (flag) {
                  thisRanking.source1.tag = 'flagged';
                }
              }
              var matchInSource2 = mcsdSource2.entry.find((entry) => {
                return entry.resource.id == match.resource.id
              })
              if (matchInSource2) {
                thisRanking.exactMatch = {
                  name: matchInSource2.resource.name,
                  parents: source2ParentNames[match.resource.id],
                  id: match.resource.id,
                };
              }
              scoreResults.push(thisRanking);
              count++
              let percent = parseFloat((count * 100 / totalRecords).toFixed(2))
              scoreResData = JSON.stringify({
                status: '3/3 - Running Automatching',
                error: null,
                percent: percent
              })
              redisClient.set(scoreRequestId, scoreResData)
              return source1Callback();
            });
          } else { // if not mapped
            const source1Name = source1Entry.resource.name;
            let source1Parents = [];
            const source1ParentNames = [];
            const source1ParentIds = [];
            if (source1Entry.resource.hasOwnProperty('partOf')) {
              var entityParent = source1Entry.resource.partOf.reference;
              var source1ParentReceived = new Promise((resolve, reject) => {
                mcsd.getLocationParentsFromData(entityParent, mcsdSource1All, 'all', (parents) => {
                  source1Parents = parents;
                  async.eachSeries(parents, (parent, nxtParent) => {
                    source1ParentNames.push(
                      parent.text,
                    );
                    source1ParentIds.push(
                      parent.id,
                    );
                    return nxtParent();
                  }, () => {
                    resolve();
                  });
                });
              });
            } else {
              var source1ParentReceived = Promise.resolve([]);
            }

            source1ParentReceived.then(() => {
              const thisRanking = {};
              thisRanking.source1 = {
                name: source1Name,
                parents: source1ParentNames,
                id: source1Entry.resource.id,
              };
              thisRanking.potentialMatches = {};
              thisRanking.exactMatch = {};
              const source2Promises = [];
              var source2Filtered = mcsdSource2.entry.filter((entry) => {
                return source2MappedParentIds[entry.resource.id].includes(source1ParentIds[0])
              })
              async.each(source2Filtered, (source2Entry, source2Callback) => {
                const id = source2Entry.resource.id;
                var ignoreThis = ignore.find((toIgnore) => {
                  return toIgnore == id
                })
                if (ignoreThis) {
                  return source2Callback()
                }
                // check if this is already mapped
                this.matchStatus(mcsdMapped, id, (mapped) => {
                  if (mapped) {
                    ignore.push(source2Entry.resource.id)
                    return source2Callback();
                  }
                  const source2Name = source2Entry.resource.name;
                  const source2Id = source2Entry.resource.id

                  lev = levenshtein.get(source2Name.toLowerCase(), source1Name.toLowerCase());
                  if (lev == 0 && !matchBroken) {
                    ignore.push(source2Entry.resource.id)
                    thisRanking.exactMatch = {
                      name: source2Name,
                      parents: source2ParentNames[source2Id],
                      id: source2Entry.resource.id,
                    };
                    thisRanking.potentialMatches = {};
                    mcsd.saveMatch(source1Id, source2Entry.resource.id, source1DB, source2DB, recoLevel, totalLevels, 'match', () => {

                    });
                    // we will need to break here and start processing nxt Source1
                    return source2Callback();
                  }
                  if (lev == 0 && matchBroken) {
                    if (!thisRanking.potentialMatches.hasOwnProperty('0')) {
                      thisRanking.potentialMatches['0'] = []
                    }
                    thisRanking.potentialMatches['0'].push({
                      name: source2Name,
                      parents: source2ParentNames[source2Id],
                      id: source2Entry.resource.id,
                    })
                    return source2Callback();
                  }
                  if (Object.keys(thisRanking.exactMatch).length == 0) {
                    if (thisRanking.potentialMatches.hasOwnProperty(lev) || Object.keys(thisRanking.potentialMatches).length < maxSuggestions) {
                      if (!thisRanking.potentialMatches.hasOwnProperty(lev)) {
                        thisRanking.potentialMatches[lev] = [];
                      }
                      thisRanking.potentialMatches[lev].push({
                        name: source2Name,
                        parents: source2ParentNames[source2Id],
                        id: source2Entry.resource.id,
                      });
                    } else {
                      const existingLev = Object.keys(thisRanking.potentialMatches);
                      const max = _.max(existingLev);
                      if (lev < max) {
                        delete thisRanking.potentialMatches[max];
                        thisRanking.potentialMatches[lev] = [];
                        thisRanking.potentialMatches[lev].push({
                          name: source2Name,
                          parents: source2ParentNames[source2Id],
                          id: source2Entry.resource.id,
                        });
                      }
                    }
                  }
                  return source2Callback();
                });
              }, () => {
                scoreResults.push(thisRanking);
                count++
                let percent = parseFloat((count * 100 / totalRecords).toFixed(2))
                scoreResData = JSON.stringify({
                  status: '3/3 - Running Automatching',
                  error: null,
                  percent: percent
                })
                redisClient.set(scoreRequestId, scoreResData)
                return source1Callback();
              });
            }).catch((err) => {
              winston.error(err);
            });
          }
        });
      }, () => {
        scoreResData = JSON.stringify({
          status: 'Done',
          error: null,
          percent: 100
        })
        redisClient.set(scoreRequestId, scoreResData)
        callback(scoreResults)
      });
    },

    getBuildingsScores(mcsdSource1, mcsdSource2, mcsdMapped, mcsdSource2All, mcsdSource1All, source1DB, source2DB, recoLevel, totalLevels, clientId, callback) {
      const scoreRequestId = `scoreResults${clientId}`
      var scoreResults = [];
      const matchBrokenCode = config.getConf('mapping:matchBrokenCode');
      var maxSuggestions = config.getConf('matchResults:maxSuggestions');
      if (mcsdSource2.total == 0) {
        winston.error('No Source2 data found for this orgunit');
        return callback();
      }
      if (mcsdSource1.total == 0) {
        winston.error('No Source1 data found');
        return callback();
      }
      var ignore = []
      var count = 0;
      var source2ParentNames = {}
      var source2MappedParentIds = {}
      const source2LevelMappingStatus = {}
      var count = 0
      winston.info('Populating parents')
      var totalRecords = mcsdSource2.entry.length
      for (entry of mcsdSource2.entry) {
        source2LevelMappingStatus[entry.resource.id] = []
        this.matchStatus(mcsdMapped, entry.resource.id, (mapped) => {
          if (mapped) {
            source2LevelMappingStatus[entry.resource.id] = true
          } else {
            source2LevelMappingStatus[entry.resource.id] = false
          }
        })
        if (entry.resource.hasOwnProperty('partOf')) {
          source2ParentNames[entry.resource.id] = [];
          source2MappedParentIds[entry.resource.id] = [];
          var entityParent = entry.resource.partOf.reference;
          mcsd.getLocationParentsFromData(entityParent, mcsdSource2All, 'all', (parents) => {
            // lets make sure that we use the mapped parent for comparing against Source1
            async.each(parents, (parent, parentCallback) => {
              this.matchStatus(mcsdMapped, parent.id, (mapped) => {
                if (mapped) {
                  const mappedPar = mapped.resource.identifier.find((identifier) => {
                    if (identifier.system == 'https://digitalhealth.intrahealth.org/source1') {
                      const source1ParId = identifier.value.split('/').pop();
                      source2MappedParentIds[entry.resource.id].push(source1ParId);
                    }
                  });
                  source2ParentNames[entry.resource.id].push(parent.text);
                } else {
                  source2MappedParentIds[entry.resource.id].push(parent.id);
                  source2ParentNames[entry.resource.id].push(parent.text);
                }
                parentCallback()
              })
            }, () => {
              count++
              const scoreRequestId = `scoreResults${clientId}`
              let percent = parseFloat((count * 100 / totalRecords).toFixed(2))
              scoreResData = JSON.stringify({
                status: '2/3 - Scanning Source2 Location Parents',
                error: null,
                percent: percent
              })
              redisClient.set(scoreRequestId, scoreResData)
              if (count === mcsdSource2.entry.length) {
                winston.info('Done populating parents')
              }
            })
          })
        }
      }
      //clear mcsdSource2All
      mcsdSource2All = {}
      winston.info('Calculating scores now')
      count = 0
      var totalRecords = mcsdSource1.entry.length
      async.eachSeries(mcsdSource1.entry, (source1Entry, source1Callback) => {
        // check if this Source1 Orgid is mapped
        const source1Id = source1Entry.resource.id;
        const source1Identifiers = source1Entry.resource.identifier;
        let source1Latitude = null;
        let source1Longitude = null;
        if (source1Entry.resource.hasOwnProperty('position')) {
          source1Latitude = source1Entry.resource.position.latitude;
          source1Longitude = source1Entry.resource.position.longitude;
        }
        const source1Identifier = URI(config.getConf('mCSD:url'))
          .segment(source1DB)
          .segment('fhir')
          .segment('Location')
          .segment(source1Id)
          .toString();

        var matchBroken = false
        if (source1Entry.resource.hasOwnProperty('tag')) {
          var matchBrokenTag = source1Entry.resource.tag.find((tag) => {
            return tag.code == matchBrokenCode
          })
          if (matchBrokenTag) {
            matchBroken = true
          }
        }
        if (source1Entry.resource.id === 'ddc431f1-d583-5b2f-8af3-95612a1cd441')
        winston.error(source1Entry.resource.id)
        this.matchStatus(mcsdMapped, source1Identifier, (match) => {
          // if this Source1 Org is already mapped
          const thisRanking = {};
          if (match) {
            const noMatchCode = config.getConf('mapping:noMatchCode');
            var entityParent = null;
            if (source1Entry.resource.hasOwnProperty('partOf')) {
              entityParent = source1Entry.resource.partOf.reference;
            }
            mcsd.getLocationParentsFromData(entityParent, mcsdSource1All, 'names', (source1Parents) => {
              const ident = source1Entry.resource.identifier.find((identifier) => {
                return identifier.system == 'https://digitalhealth.intrahealth.org/source1'
              })
              let source1BuildingId = null;
              if (ident) {
                source1BuildingId = ident.value;
              }
              thisRanking.source1 = {
                name: source1Entry.resource.name,
                parents: source1Parents,
                lat: source1Latitude,
                long: source1Longitude,
                id: source1BuildingId,
              };
              thisRanking.potentialMatches = {};
              thisRanking.exactMatch = {};
              let noMatch = null;
              if (match.resource.hasOwnProperty('tag')) {
                noMatch = match.resource.tag.find(tag => tag.code == noMatchCode);
              }
              // in case this is marked as no match then process next Source1
              if (noMatch) {
                thisRanking.source1.tag = 'noMatch';
                scoreResults.push(thisRanking);
                count++
                let percent = parseFloat((count * 100 / totalRecords).toFixed(2))
                scoreResData = JSON.stringify({
                  status: '3/3 - Running Automatching',
                  error: null,
                  percent: percent
                })
                redisClient.set(scoreRequestId, scoreResData)
                return source1Callback();
              }

              //if this is flagged then process next Source1
              const flagCode = config.getConf('mapping:flagCode');
              if (match.resource.hasOwnProperty('tag')) {
                const flag = match.resource.tag.find(tag => tag.code == flagCode);
                winston.error(flag)
                if (flag) {
                  thisRanking.source1.tag = 'flagged';
                }
              }

              var matchInSource2 = mcsdSource2.entry.find((entry) => {
                return entry.resource.id == match.resource.id
              })
              if (matchInSource2) {
                thisRanking.exactMatch = {
                  name: matchInSource2.resource.name,
                  parents: source2ParentNames[match.resource.id],
                  id: match.resource.id,
                };
              }
              scoreResults.push(thisRanking);
              count++
              let percent = parseFloat((count * 100 / totalRecords).toFixed(2))
              scoreResData = JSON.stringify({
                status: '3/3 - Running Automatching',
                error: null,
                percent: percent
              })
              redisClient.set(scoreRequestId, scoreResData)
              return source1Callback();
            });
          } else { // if not mapped
            const source1Name = source1Entry.resource.name;
            const source1ParentNames = [];
            const source1ParentIds = [];
            if (source1Entry.resource.hasOwnProperty('partOf')) {
              var entityParent = source1Entry.resource.partOf.reference;
              var source1ParentReceived = new Promise((resolve, reject) => {
                mcsd.getLocationParentsFromData(entityParent, mcsdSource1All, 'all', (parents) => {
                  source1Parents = parents;
                  async.eachSeries(parents, (parent, nxtParent) => {
                    source1ParentNames.push(
                      parent.text,
                    );
                    source1ParentIds.push(
                      parent.id
                    )
                    return nxtParent();
                  }, () => {
                    resolve();
                  });
                });
              });
            } else {
              var source1ParentReceived = Promise.resolve([]);
            }
            source1ParentReceived.then(() => {
              const thisRanking = {};
              let source1BuildingId = null;
              const ident = source1Entry.resource.identifier.find((identifier) => {
                return identifier.system == 'https://digitalhealth.intrahealth.org/source1'
              })
              if (ident) {
                source1BuildingId = ident.value;
              }
              thisRanking.source1 = {
                name: source1Name,
                parents: source1ParentNames,
                lat: source1Latitude,
                long: source1Longitude,
                id: source1BuildingId,
              };
              thisRanking.potentialMatches = {};
              thisRanking.exactMatch = {};
              var source2Filtered = mcsdSource2.entry.filter((entry) => {
                // in case there are different levels of parents (only Source2 can have more levels due to import)
                return source2MappedParentIds[entry.resource.id].includes(source1ParentIds[0])
              })
              async.eachSeries(source2Filtered, (source2Entry, source2Callback) => {
                if (Object.keys(thisRanking.exactMatch).length > 0) {
                  return source2Callback()
                }
                const id = source2Entry.resource.id;
                const source2Identifiers = source2Entry.resource.identifier;
                //if this source2 is already mapped then skip it
                var ignoreThis = ignore.find((toIgnore) => {
                  return toIgnore == id
                })
                if (ignoreThis) {
                  return source2Callback()
                }
                //if this is already mapped then ignore
                if (source2LevelMappingStatus[id]) {
                  return source2Callback();
                }

                const source2Name = source2Entry.resource.name;
                let source2Latitude = null;
                let source2Longitude = null;
                if (source2Entry.resource.hasOwnProperty('position')) {
                  source2Latitude = source2Entry.resource.position.latitude;
                  source2Longitude = source2Entry.resource.position.longitude;
                }
                if (source2Latitude && source2Longitude) {
                  var dist = geodist({
                    source2Latitude,
                    source2Longitude
                  }, {
                    source1Latitude,
                    source1Longitude
                  }, {
                    exact: false,
                    unit: 'miles'
                  });
                }
                source2IdPromises = [];
                // check if IDS are the same and mark as exact match
                const matchingIdent = source2Identifiers.find(datIdent => source1Identifiers.find(source1Ident => datIdent.value == source1Ident.value));
                if (matchingIdent && !matchBroken) {
                  ignore.push(source2Entry.resource.id)
                  thisRanking.exactMatch = {
                    name: source2Name,
                    parents: source2ParentNames[source2Entry.resource.id],
                    lat: source2Latitude,
                    long: source2Longitude,
                    geoDistance: dist,
                    id: source2Entry.resource.id,
                  };
                  thisRanking.potentialMatches = {};
                  mcsd.saveMatch(source1Id, source2Entry.resource.id, source1DB, source2DB, recoLevel, totalLevels, 'match', () => {

                  });
                  return source2Callback();
                } else if (matchingIdent && matchBroken) {
                  if (!thisRanking.potentialMatches.hasOwnProperty('0')) {
                    thisRanking.potentialMatches['0'] = []
                  }
                  thisRanking.potentialMatches['0'].push({
                    name: source2Name,
                    parents: source2ParentNames[source2Entry.resource.id],
                    lat: source2Latitude,
                    long: source2Longitude,
                    geoDistance: dist,
                    id: source2Entry.resource.id
                  })
                  return source2Callback();
                }

                if (!matchBroken) {
                  const dictionary = config.getConf("dictionary")
                  for (let abbr in dictionary) {
                    const replaced = source1Name.replace(abbr, dictionary[abbr])
                    if (replaced.toLowerCase() === source2Name.toLowerCase()) {
                      ignore.push(source2Entry.resource.id)
                      thisRanking.exactMatch = {
                        name: source2Name,
                        parents: source2ParentNames[source2Entry.resource.id],
                        lat: source2Latitude,
                        long: source2Longitude,
                        geoDistance: dist,
                        id: source2Entry.resource.id,
                      };
                      thisRanking.potentialMatches = {};
                      mcsd.saveMatch(source1Id, source2Entry.resource.id, source1DB, source2DB, recoLevel, totalLevels, 'match', () => {});
                      return source2Callback();
                    }
                  }
                }

                lev = levenshtein.get(source2Name.toLowerCase(), source1Name.toLowerCase());
                if (lev == 0 && !matchBroken) {
                  ignore.push(source2Entry.resource.id)
                  thisRanking.exactMatch = {
                    name: source2Name,
                    parents: source2ParentNames[source2Entry.resource.id],
                    lat: source2Latitude,
                    long: source2Longitude,
                    geoDistance: dist,
                    id: source2Entry.resource.id,
                  };
                  thisRanking.potentialMatches = {};
                  mcsd.saveMatch(source1Id, source2Entry.resource.id, source1DB, source2DB, recoLevel, totalLevels, 'match', () => {

                  });
                  return source2Callback();
                } else if (lev == 0 && matchBroken) {
                  if (!thisRanking.potentialMatches.hasOwnProperty('0')) {
                    thisRanking.potentialMatches['0'] = []
                  }
                  thisRanking.potentialMatches['0'].push({
                    name: source2Name,
                    parents: source2ParentNames[source2Entry.resource.id],
                    lat: source2Latitude,
                    long: source2Longitude,
                    geoDistance: dist,
                    id: source2Entry.resource.id,
                  })
                  return source2Callback();
                }
                if (Object.keys(thisRanking.exactMatch).length == 0) {
                  if (thisRanking.potentialMatches.hasOwnProperty(lev) || Object.keys(thisRanking.potentialMatches).length < maxSuggestions) {
                    if (!thisRanking.potentialMatches.hasOwnProperty(lev)) {
                      thisRanking.potentialMatches[lev] = [];
                    }
                    thisRanking.potentialMatches[lev].push({
                      name: source2Name,
                      parents: source2ParentNames[source2Entry.resource.id],
                      lat: source2Latitude,
                      long: source2Longitude,
                      geoDistance: dist,
                      id: source2Entry.resource.id,
                    });
                  } else {
                    const existingLev = Object.keys(thisRanking.potentialMatches);
                    const max = _.max(existingLev);
                    if (lev < max) {
                      delete thisRanking.potentialMatches[max];
                      thisRanking.potentialMatches[lev] = [];
                      thisRanking.potentialMatches[lev].push({
                        name: source2Name,
                        parents: source2ParentNames[source2Entry.resource.id],
                        lat: source2Latitude,
                        long: source2Longitude,
                        geoDistance: dist,
                        id: source2Entry.resource.id,
                      });
                    }
                  }
                }
                return source2Callback();
              }, () => {
                scoreResults.push(thisRanking);
                count++;
                let percent = parseFloat((count * 100 / totalRecords).toFixed(2))
                scoreResData = JSON.stringify({
                  status: '3/3 - Running Automatching',
                  error: null,
                  percent: percent
                })
                redisClient.set(scoreRequestId, scoreResData)
                return source1Callback();
              });
            }).catch((err) => {
              winston.error(err);
            });
          }
        });
      }, () => {
        scoreResData = JSON.stringify({
          status: 'Done',
          error: null,
          percent: 100
        })
        redisClient.set(scoreRequestId, scoreResData)
        callback(scoreResults)
      });
    },
    matchStatus(mcsdMapped, id, callback) {
      if (mcsdMapped.length === 0 || !mcsdMapped) {
        return callback();
      }
      const status = mcsdMapped.entry.find(entry => entry.resource.id === id || (entry.resource.hasOwnProperty('identifier') && entry.resource.identifier.find(identifier => identifier.value === id)));
      return callback(status);
    },
    getUnmatched(mcsdSource2All, mcsdSource2, source1, source2, callback) {
      const database = source1 + source2;
      const unmatched = [];
      mcsd.getLocations(database, (mappedLocations) => {
        let parentCache = {}
        async.each(mcsdSource2.entry, (source2Entry, source2Callback) => {

          let matched = mappedLocations.entry.find((entry) => {
            return entry.resource.id === source2Entry.resource.id && entry.resource.identifier.length === 2
          })
          if (!matched) {
            const name = source2Entry.resource.name;
            const id = source2Entry.resource.id;
            let entityParent = null;
            if (source2Entry.resource.hasOwnProperty('partOf')) {
              entityParent = source2Entry.resource.partOf.reference;
            }
            if (!parentCache[entityParent]) {
              parentCache[entityParent] = []
              mcsd.getLocationParentsFromData(entityParent, mcsdSource2All, 'names', (source2Parents) => {
                parentCache[entityParent] = source2Parents
                unmatched.push({
                  id,
                  name,
                  parents: parentCache[entityParent]
                });
                return source2Callback();
              });
            } else {
              unmatched.push({
                id,
                name,
                parents: parentCache[entityParent]
              });
              return source2Callback();
            }
          } else {
            return source2Callback();
          }
        }, () => {
          callback(unmatched);
        });
      })
    },
    getMappingStatus(source1Locations, source2Locations, mappedLocations, source1DB, clientId, callback) {
      const noMatchCode = config.getConf('mapping:noMatchCode');
      const flagCode = config.getConf('mapping:flagCode');
      var mappingStatus = {}
      mappingStatus.mapped = []
      mappingStatus.notMapped = []
      mappingStatus.flagged = []
      mappingStatus.noMatch = []
      let count = 0
      async.each(source1Locations.entry, (entry, source1Callback) => {
        const ident = entry.resource.identifier.find(identifier => identifier.system == 'https://digitalhealth.intrahealth.org/source1');
        let source1UploadedId = null;
        if (ident) {
          source1UploadedId = ident.value;
        }
        const source1Id = entry.resource.id;
        const source1Identifier = URI(config.getConf('mCSD:url'))
          .segment(source1DB)
          .segment('fhir')
          .segment('Location')
          .segment(source1Id)
          .toString()
        this.matchStatus(mappedLocations, source1Identifier, (mapped) => {
          if (mapped) {
            var source2Entry = source2Locations.entry.find((source2Entry) => {
              return source2Entry.resource.id === mapped.resource.id
            })
            let nomatch, flagged
            if (mapped.resource.hasOwnProperty('tag')) {
              nomatch = mapped.resource.tag.find((tag) => {
                return tag.code === noMatchCode
              })
            }
            if (mapped.resource.hasOwnProperty('tag')) {
              flagged = mapped.resource.tag.find((tag) => {
                return tag.code === flagCode
              })
            }
            if (flagged) {
              mappingStatus.flagged.push({
                source1Name: entry.resource.name,
                source1Id: source1UploadedId,
                source2Name: source2Entry.resource.name,
                source2Id: source2Entry.resource.id
              })
            } else if (nomatch) {
              mappingStatus.noMatch.push({
                source1Name: entry.resource.name,
                source1Id: source1UploadedId
              })
            } else {
              mappingStatus.mapped.push({
                source1Name: entry.resource.name,
                source1Id: source1UploadedId,
                source2Name: source2Entry.resource.name,
                source2Id: source2Entry.resource.id
              })
            }
            count++
            let statusRequestId = `mappingStatus${clientId}`
            let percent = parseFloat((count * 100 / source1Locations.entry.length).toFixed(2))
            statusResData = JSON.stringify({
              status: '2/2 - Loading Source2 and Source1 Data',
              error: null,
              percent: percent
            })
            redisClient.set(statusRequestId, statusResData)
            source1Callback()
          } else {
            mappingStatus.notMapped.push({
              source1Name: entry.resource.name,
              source1Id: source1UploadedId
            })
            count++
            let statusRequestId = `mappingStatus${clientId}`
            let percent = parseFloat((count * 100 / source1Locations.entry.length).toFixed(2))
            statusResData = JSON.stringify({
              status: '2/2 - Loading Source2 and Source1 Data',
              error: null,
              percent: percent
            })
            redisClient.set(statusRequestId, statusResData)
            source1Callback()
          }
        })
      }, () => {
        let statusRequestId = `mappingStatus${clientId}`
        statusResData = JSON.stringify({
          status: 'Done',
          error: null,
          percent: 100
        })
        redisClient.set(statusRequestId, statusResData)
        return callback(mappingStatus)
      })
    }

  };
};