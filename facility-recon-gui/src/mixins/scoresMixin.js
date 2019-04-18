import axios from 'axios'
import {generalMixin} from './generalMixin'
import { eventBus } from '../main'

const backendServer = process.env.BACKEND_SERVER
export const scoresMixin = {
  mixins: [generalMixin],
  data () {
    return {
      scoreProgressTitle: 'Waiting for progress status',
      scoreDialog: false,
      scoreProgressPercent: null,
      progressType: '',
      scoreProgressTimer: false,
      loadingSource2Unmatched: false,
      loadingSource1Unmatched: false
    }
  },
  methods: {
    checkScoreProgress () {
      const clientId = this.$store.state.clientId
      axios.get(backendServer + '/scoreProgress/' + clientId).then((scoreProgress) => {
        if (scoreProgress.data === null || scoreProgress.data === undefined || scoreProgress.data === false ||
          (scoreProgress.data.status === null && scoreProgress.data.percent === null && scoreProgress.data.error === null)) {
          clearInterval(this.scoreProgressTimer)
          return
        }
        this.scoreProgressTitle = scoreProgress.data.status
        if (scoreProgress.data.percent) {
          if (this.progressType !== 'percent') {
            this.progressType = 'percent'
          }
          this.scoreProgressPercent = scoreProgress.data.percent
        }
        if (scoreProgress.data.status === 'Done') {
          clearInterval(this.scoreProgressTimer)
          this.scoreDialog = false
          this.scoreProgressTitle = 'Waiting for progress status'
        }
      }).catch((err) => {
        console.log(err)
      })
    },
    getScores () {
      let source1 = this.getSource1()
      let source2 = this.getSource2()
      let sourcesOwner = this.getDatasourceOwner()
      this.$store.state.source1UnMatched = []
      this.$store.state.source2UnMatched = []
      this.$store.state.matchedContent = []
      this.$store.state.noMatchContent = []
      this.$store.state.ignoreContent = []
      this.$store.state.flagged = []
      this.$store.state.source1TotalAllRecords = 0
      this.$store.state.totalAllMapped = 0
      this.$store.state.totalAllFlagged = 0
      this.$store.state.totalAllNoMatch = 0
      this.$store.state.totalAllIgnore = 0
      this.$store.state.source2TotalRecords = 0
      this.$store.state.scoreResults = []
      if (!source1 || !source2) {
        return
      }
      this.loadingSource1Unmatched = true
      this.loadingSource2Unmatched = true
      this.scoreDialog = true
      this.scoreProgressTitle = 'Waiting for progress status'
      this.progressType = 'indeterminate'
      let recoLevel = this.$store.state.recoLevel
      let totalSource1Levels = this.$store.state.totalSource1Levels
      let totalSource2Levels = this.$store.state.totalSource2Levels
      const clientId = this.$store.state.clientId
      let topTree = this.$store.state.source1Parents.slice(0, this.$store.state.source1Parents.length)

      // generating levels
      this.$store.state.levelArray = []
      for (var k = 1; k < this.$store.state.totalSource1Levels; k++) {
        let text
        if (k + 1 > this.$store.state.recoLevel) {
          continue
        }
        text = this.translateDataHeader('source1', k)
        this.$store.state.levelArray.push({
          text: text,
          value: k + 1
        })
      }
      let userID = this.$store.state.activePair.userID._id
      let source1Owner = sourcesOwner.source1Owner
      let source2Owner = sourcesOwner.source2Owner
      let source1LimitOrgId = this.getLimitOrgIdOnActivePair().source1LimitOrgId
      let source2LimitOrgId = this.getLimitOrgIdOnActivePair().source2LimitOrgId
      let parentConstraint = JSON.stringify(this.$store.state.config.generalConfig.reconciliation.parentConstraint)
      let path = `source1=${source1}&source2=${source2}&source1Owner=${source1Owner}&source2Owner=${source2Owner}&source1LimitOrgId=${source1LimitOrgId}&source2LimitOrgId=${source2LimitOrgId}&totalSource1Levels=${totalSource1Levels}&totalSource2Levels=${totalSource2Levels}`
      path += `&recoLevel=${recoLevel}&clientId=${clientId}&userID=${userID}&parentConstraint=` + parentConstraint
      axios.get(backendServer + '/reconcile/?' + path).then((scores) => {
        this.loadingSource1Unmatched = false
        this.getSource2Unmached()
        this.$store.state.source1UnMatched = []
        this.$store.state.matchedContent = []
        this.$store.state.noMatchContent = []
        this.$store.state.ignoreContent = []
        this.$store.state.flagged = []
        this.$store.state.scoreResults = scores.data.scoreResults
        this.$store.state.source2TotalRecords = scores.data.source2TotalRecords
        this.$store.state.source2TotalAllRecords = scores.data.source2TotalAllRecords
        this.$store.state.totalAllMapped = scores.data.totalAllMapped
        this.$store.state.totalAllFlagged = scores.data.totalAllFlagged
        this.$store.state.totalAllNoMatch = scores.data.totalAllNoMatch
        this.$store.state.totalAllIgnore = scores.data.totalAllIgnore
        this.$store.state.source1TotalAllNotMapped = scores.data.source1TotalAllNotMapped
        this.$store.state.source1TotalAllRecords = scores.data.source1TotalAllRecords
        for (let scoreResult of this.$store.state.scoreResults) {
          if (scoreResult.source1.hasOwnProperty('tag') && scoreResult.source1.tag === 'flagged') {
            this.$store.state.flagged.push({
              source1Name: scoreResult.source1.name,
              source1Id: scoreResult.source1.id,
              source1Parents: scoreResult.source1.parents,
              source2Name: scoreResult.exactMatch.name,
              source2Id: scoreResult.exactMatch.id,
              source2Parents: scoreResult.exactMatch.parents,
              flagComment: scoreResult.source1.flagComment
            })
          } else if (scoreResult.source1.hasOwnProperty('tag') && scoreResult.source1.tag === 'noMatch') {
            let parents = scoreResult.source1.parents
            this.$store.state.noMatchContent.push({
              source1Name: scoreResult.source1.name,
              source1Id: scoreResult.source1.id,
              parents: parents
            })
          } else if (scoreResult.source1.hasOwnProperty('tag') && scoreResult.source1.tag === 'ignore') {
            let parents = scoreResult.source1.parents
            this.$store.state.ignoreContent.push({
              source1Name: scoreResult.source1.name,
              source1Id: scoreResult.source1.id,
              parents: parents
            })
          } else if (Object.keys(scoreResult.exactMatch).length > 0) {
            this.$store.state.matchedContent.push({
              source1Name: scoreResult.source1.name,
              source1Id: scoreResult.source1.id,
              source1Parents: scoreResult.source1.parents,
              source2Name: scoreResult.exactMatch.name,
              source2Id: scoreResult.exactMatch.id,
              source2Parents: scoreResult.exactMatch.parents,
              matchComments: scoreResult.exactMatch.matchComments
            })
          } else {
            let addTree = topTree
            for (let i = scoreResult.source1.parents.length - 1; i >= 0; i--) {
              if (!addTree[scoreResult.source1.parents[i]]) {
                addTree[scoreResult.source1.parents[i]] = {}
              }
              addTree = addTree[scoreResult.source1.parents[i]]
            }
            this.$store.state.source1UnMatched.push({
              name: scoreResult.source1.name,
              id: scoreResult.source1.id,
              parents: scoreResult.source1.parents
            })
          }
        }
        this.$store.state.source1Parents = topTree
      })
      this.scoreProgressTimer = setInterval(this.checkScoreProgress, 1000)
    },
    getSource2Unmached () {
      let source1 = this.getSource1()
      let source2 = this.getSource2()
      let userID = this.$store.state.activePair.userID._id
      let sourcesOwner = this.getDatasourceOwner()
      let source1Owner = sourcesOwner.source1Owner
      let source2Owner = sourcesOwner.source2Owner
      let source1LimitOrgId = this.getLimitOrgIdOnActivePair().source1LimitOrgId
      let source2LimitOrgId = this.getLimitOrgIdOnActivePair().source2LimitOrgId
      if (!source1 || !source2) {
        return
      }
      let recoLevel = this.$store.state.recoLevel
      let totalSource1Levels = this.$store.state.totalSource1Levels
      let totalSource2Levels = this.$store.state.totalSource2Levels
      let level = recoLevel
      if (recoLevel === totalSource1Levels) {
        level = totalSource2Levels
      }
      axios.get(backendServer + `/getUnmatched/${source1}/${source2}/${source1Owner}/${source2Owner}/${level}/${userID}?source1LimitOrgId=${source1LimitOrgId}&source2LimitOrgId=${source2LimitOrgId}`).then((unmatched) => {
        this.loadingSource2Unmatched = false
        this.$store.state.source2UnMatched = unmatched.data
      })
    },
    getSource1 () {
      let source = this.$store.state.activePair.source1.name
      if (source) {
        source = this.toTitleCase(source)
      }
      return source
    },
    getSource2 () {
      let source = this.$store.state.activePair.source2.name
      if (source) {
        source = this.toTitleCase(source)
      }
      return source
    },
    getSource1Name () {
      return this.$store.state.activePair.source1.name
    },
    getSource2Name () {
      return this.$store.state.activePair.source2.name
    }
  },
  created () {
    eventBus.$on('changeCSVHeaderNames', () => {
      this.$store.state.levelArray = []
      for (var k = 1; k < this.$store.state.totalSource1Levels; k++) {
        let text
        if (k + 1 > this.$store.state.recoLevel) {
          continue
        }
        text = this.translateDataHeader('source1', k)
        this.$store.state.levelArray.push({
          text: text,
          value: k + 1
        })
      }
    })
    this.scoreProgressTitle = this.$store.state.scoresProgressData.scoreProgressTitle
    this.scoreProgressPercent = this.$store.state.scoresProgressData.scoreProgressPercent
    if (this.$store.state.scoresProgressData.scoreDialog) {
      this.scoreDialog = this.$store.state.scoresProgressData.scoreDialog
    } else {
      this.scoreDialog = false
    }
    this.progressType = this.$store.state.scoresProgressData.progressType
    this.scoreProgressTimer = this.$store.state.scoresProgressData.scoreProgressTimer
    if (this.scoreDialog) {
      this.scoreProgressTimer = setInterval(this.checkScoreProgress, 1000)
    }
  },
  destroyed () {
    this.$store.state.scoresProgressData.scoreProgressTitle = this.scoreProgressTitle
    this.$store.state.scoresProgressData.scoreProgressPercent = this.scoreProgressPercent
    this.$store.state.scoresProgressData.scoreDialog = this.scoreDialog
    this.$store.state.scoresProgressData.progressType = this.progressType
    this.$store.state.scoresProgressData.scoreProgressTimer = this.scoreProgressTimer
    clearInterval(this.scoreProgressTimer)
  }
}
