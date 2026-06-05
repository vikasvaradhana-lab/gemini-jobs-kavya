const axios = require('axios');

(async () => {
  const url = 'https://biontech.wd3.myworkdayjobs.com/wday/cxs/biontech/BNT/jobs';
  console.log('Posting to BioNTech Workday API:', url);
  try {
    const res = await axios.post(url, {
      appliedFacets: {},
      limit: 20,
      offset: 0,
      searchText: ""
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
      }
    });
    console.log('Success! Status:', res.status);
    console.log('Total jobs found:', res.data.total);
    console.log('First posting:', res.data.jobPostings[0]);
  } catch (e) {
    console.error('Error fetching BioNTech Workday API:', e.message);
    if (e.response) {
      console.error('Response Status:', e.response.status);
      console.error('Response Data:', JSON.stringify(e.response.data, null, 2));
    }
  }
})();
