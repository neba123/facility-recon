import Vue from 'vue'
import Vuex from 'vuex'

Vue.use(Vuex)

export const store = new Vuex.Store({
  // Nigeria PqlFzhuPcF1
  // Malawi lZsCb6y0KDX
  // Tanzania mdXu6iCbn2G
  // Global ybg3MO3hcf4
  state: {
    recoStatus: {'status': 'on-progress'},
    dialogError: false,
    errorTitle: '',
    errorDescription: '',
    clientId: null,
    denyAccess: true,
    datimHierarchy: '',
    mohHierarchy: '',
    uploadRunning: false,
    orgUnit: { OrgId: 'PqlFzhuPcF1', OrgName: 'Nigeria' },
    mohTotalAllRecords: 0,
    datimTotalAllRecords: 0,
    totalAllMapped: 0,
    totalAllFlagged: 0,
    totalAllNoMatch: 0,
    datimTotalRecords: 0,
    totalLevels: '',
    recoLevel: 2,
    matchedContent: null,
    noMatchContent: null,
    flagged: null,
    mohParents: [],
    datimUnMatched: null,
    mohUnMatched: null,
    scoreResults: [],
    levelArray: [],
    showArchives: false,
    scoresProgressData: {},
    uploadProgressData: {}
  }
})
