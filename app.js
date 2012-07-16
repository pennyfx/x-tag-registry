var path = require('path'),
	_ = require('underscore'),
	express = require('express'),
	app = express.createServer(),
	exgf = require('amanda'),
	elastical = require('elastical'),	
	Sequelize = require('sequelize'),
	sanitize = require('validator').sanitize,
	Settings = require('settings');

var config = new Settings(require('./config'));

console.log("App starting: ", process.env, " db:",config.db.host, " es:", config.es.host);

var sequelize = new Sequelize(config.db.database, 
	config.db.user, config.db.password, { host: config.db.host });

var es_client = new elastical.Client(config.es.host, 
	{ port: config.es.port });

var XTagRepo 	= sequelize.import(__dirname + '/models/xtagrepo');
var XTagElement = sequelize.import(__dirname + '/models/xtagelement')
XTagRepo.hasMany(XTagElement);
sequelize.sync();

app.disable('view cache');
app.use(express.logger());
app.use(express.bodyParser());
app.use(express.static(__dirname + '/public'));

app.post('/customtag', function(req, res){
	console.log("DEBUG:", req.body.payload);
	var gitHubData = JSON.parse(sanitize(req.body.payload).xss() || '{}');
	exgf.validate(gitHubData, require('./lib/schemas').github, function(err){
		if (err){
			console.log("deal breaker:", gitHubData);
			return res.send(400);
		}

		// only analyize git tags that start with xtag
		if (gitHubData.ref.indexOf('refs/tags/xtag')!=0){
			console.log("Ignoring webhook for ", gitHubData.repository.url, gitHubData.ref);
			return res.send(200);
		}

		res.send(200); // respond early to github

		console.log("Processing webhook data from:", gitHubData.repository.url);

		addUpdateRepo(gitHubData, function(err, repo){
			if (err) {
				console.log("addUpdateRepo error:", err);
			} else {
				gitHubData.repoId = repo.id;
				gitHubData.forked_from = repo.forked_from;
				gitHubData.branchUrl = gitHubData.repository.url + "/" + path.join("tree", gitHubData.ref.split('/')[2]);
				findControls(gitHubData);
			}
		});
	});
});

app.get('/search', function(req, res){
	console.log("searching",req.query);
	var query = {
		index: config.es.index,
		type: 'element',
		filter: { 'and' : []}
	};
	if (req.query.query){
		query.query = {
			"bool":{
				"should":[
					{ 
						"text": { "name": { "query": req.query.query, "boost": 3.0 }}
					},
					{ 
						"text": { "description": { "query": req.query.query, "boost": 2.0 }}
					},
					{ 
						"text": { "all": { "query": req.query.query, "boost": 1.5 }}
					},
				]
			}
		}
	}	
	if (req.query.category){		
		query.filter.and.push({
			"terms": { "categories": req.query.category.split(',') }
		});
	}
	if (req.query.compatibility){		
		_.each(req.query.compatibility, function(item, key){
			var range = { "range" : {} };
			range["range"]["compatibility." + key] = {
				"lte": Number(item),
			}
			query.filter.and.push(range);
		});
	}
	if (req.query.forked && req.query.forked == 'true'){
		// no filter?
	} else {
		query.filter.and.push({
			"term": { "forked": "false" }
		});
	}
	if (req.query.author){
		query.filter.and.push({
			"term": { "author": req.query.author }
		});
	}
	if (!req.query.query){
		query.size = 100;
		query.sort = [
				{ "created_at": { "order": "desc" } }
			]
	}

	es_client.search(query, function(err, es_result, raw){
		console.log("ES search response", err, es_result, raw);

		if (es_result && es_result.hits && es_result.hits.length){
			
			var ids = es_result.hits.map(function(h){ return h['_id']; });
			var query = "SELECT e.id, e.name, e.tag_name, e.url, e.category, " +
				"e.images, e.compatibility, e.demo_url, e.version, " + 
				"e.description, r.repo, r.title as repo_name, r.author, " +
				"r.forked, r.forked_from FROM XTagElements e " +
				"JOIN XTagRepoes r ON e.`XTagRepoId` = r.id " +
				"WHERE e.id IN (" + ids.join(',')  + ")";

			var query = sequelize.query(query, {}, {raw: true});
			query.success(function(results){
				if (results && results.length){
					res.json({ data: es_result.hits.map(function(hit){
						// reorder to es sort
						var id = hit['_id'];
						for (var i = 0; i < results.length; i++ ){
							if (id == results[i].id){
								results[i].compatibility = JSON.parse(results[i].compatibility);
								results[i].category = results[i].category.split(',');
								results[i].images = results[i].images.split(',');
								results[i].versions = hit['_source'].versions;
								results[i].forked = results[i].forked ? true : false;
								return results[i];
							}
						}
					})}, 200);
				} else {
					console.log("error finding IDs in DB", ids);
					res.json({ data: [], error: "error finding IDs in DB"}, 500);
				}	

			});
			query.failure(function(err){
				res.json({ error:err, data:[]}, 500);
			});

		} else {
			res.json({ data: []}, 200);
		}
	});
});

app.listen(process.env.PORT || process.env.VCAP_APP_PORT || 3000);

/*
	TODO: move these methods out of here
*/
var addUpdateRepo = function(ghData, callback){	

	XTagRepo.find({ where: {repo: ghData.repository.url }}).success(function(repo){		
		if (repo){
			repo.updateAttributes({ 
				title: ghData.repository.name,
				description: ghData.repository.description,
				email: ghData.repository.owner.email,			
			}).error(function(err){				
				callback("error updating repo: " + ghData.repository.url + ", " + err, null);
			}).success(function(){
				console.log("repo " + ghData.repository.url + " updated");
				callback(null, repo);
			});
		} else {

			var createRepo = function(forked_from){
				XTagRepo.create({
					repo: ghData.repository.url,
					title: ghData.repository.name, 
					description: ghData.repository.description,
					author: ghData.repository.owner.name,
					email: ghData.repository.owner.email,
					forked: ghData.repository.fork, 
					forked_from: forked_from,
				}).error(function(err){
					callback("error creating rerepopo: " + ghData.repository.url + ", " + err, null);
				}).success(function(repo){
					console.log("repo " + ghData.repository.url + " created");
					callback(null, repo);
				});
			}

			if (ghData.repository.fork){
				fetchForkedFrom(ghData.repository.url, createRepo);
			} else {
				createRepo(null);
			}
		}
	});

}

var fetchForkedFrom = function(repoUrl, callback){
	var host = 'api.github.com';	
	var http = require('https');
	http.get({
		host: host,
		path: 'repos/' + repoUrl.replace('https://github.com/','')
	}, function(res){
		res.setEncoding('utf8');
		if (res.statusCode == 200){
			var data = '';
			res.on('data', function(chuck){
				data += chuck;
			});
			res.on('end', function(){
				try {
					var repo = JSON.parse(sanitize(data).xss());					
					callback(repo.parent.svn_url);
				} catch(e) { 
					console.log("error parsing github data: " + e + "\n" + data);
					callback(null);
				}
			});
		} else {
			console.log("request returned:" + res.statusCode, host, repoUrl);
			callback(null);
		}
	}).on('error', function(err){
		console.log("error making request:", host, repoUrl);
		callback(null);
	});
}

var findControls = function(ghData){

	var baseRepoUrl = buildXtagJsonUrl(ghData.repository.url, ghData.ref);
	var onComplete = function(err, xtagJson){
		if (err){
			console.log("error fetching xtag.json:", err);
			//contact user?
			return;
		}

		if (xtagJson.xtags){
			xtagJson.xtags.forEach(function(tagUrl){
				var tmpUrl = path.join(baseRepoUrl, tagUrl);
				fetchXtagJson(tmpUrl, function(err, xtagJson){
					if (xtagJson) xtagJson.controlLocation = ghData.branchUrl + "/" + tagUrl;
					onComplete(err, xtagJson);
				});
			});
		} 

		exgf.validate(xtagJson, require('./lib/schemas').xtagJson, function(err){
			if (err) {
				if (!xtagJson.xtags){						
					console.log("invalid xtag.json", err, "\n-------\n",xtagJson, "\n-------\n");
				}
				return;
			}
			processXtagJson(ghData, xtagJson);
		});
	}

	try {
		fetchXtagJson(baseRepoUrl, function(err, xtagJson){
			if (xtagJson) xtagJson.controlLocation = ghData.branchUrl;
			onComplete(err, xtagJson);
		});
	} catch(e){
		console.log("error in fetchXtagJson", e);
	}
}

var processXtagJson = function(repoData, xtagJson){
	
	console.log("processing control\n-------\n", xtagJson, "\n-------\n");
	// create XTagElements
	// check to see if Element already exists
	// query by tagName && XTagRepoId
	XTagElement.findAll({ 
		where: {
			tag_name: xtagJson.tagName,
			XTagRepoId: repoData.repoId,
		}, order: 'id ASC'}).success(function(tags){

		// remove all previous versions from ES
		var alreadyExists = false;
		var previousVersions = [];
		(tags||[]).forEach(function(t){
			previousVersions.push({ version: t.version, url: t.url });
			if (t.version != xtagJson.version && t.is_current){
				t.is_current = false;
				t.save().success(function(t){
					es_client.delete(config.es.index, 'element', t.id, function(err, res){
						console.log("ES Delete:", t.id, "  ERR:", err, "  RES:",res);
					});
				});
			} else if (t.version == xtagJson.version){
				alreadyExists = true;
			}
		});

		if (alreadyExists){
			return console.log("control already exists");
		}

		var categories = ["structural", "media", "input", "navigation", "behavioral"];

		XTagElement.create({
			name: xtagJson.name,
			tag_name: xtagJson.tagName,
			description: xtagJson.description,
			category: (xtagJson.categories || []).join(','),
			images: (xtagJson.images || []).join(','),
			compatibility: JSON.stringify(xtagJson.compatibility),
			demo_url: xtagJson.demo,
			url: xtagJson.controlLocation,
			version: xtagJson.version,
			revision: repoData.after,
			ref: repoData.ref,
			raw: JSON.stringify(xtagJson),
			XTagRepoId: repoData.repoId,
			is_current: true,
		}).success(function(tag){
			console.log("saved control", xtagJson.name, tag.values);
			//index into ES
			es_client.index(config.es.index, 'element', {
				name: tag.name,
				tag_name: tag.tag_name,
				description: tag.description,
				categories: xtagJson.categories,
				compatibility: xtagJson.compatibility,
				created_at: tag.createdAt,
				demo_url: tag.demo_url,
				url: tag.url,
				version: tag.version,
				revision: tag.revision,
				repo_name: repoData.repository.name,
				author: repoData.repository.owner.name,
				versions: previousVersions,
				forked: repoData.repository.forked ? "true" : "false",
				forked_from: repoData.repository.forked_from,
				all: tag.name + " " + tag.tag_name + " " + tag.description
			}, 
			{ 
				id: tag.id.toString(), refresh:true 
			}, 
			function(err, res){
				console.log("ES response", err, res);
			});
		}).error(function(err){
			console.log("error saving control", err);
		});
		
	}).error(function(err){
		console.log("error finding xtagelement", err);
	});
	
}

var buildXtagJsonUrl = function(repoUrl, ref){
	var xtagJsonUrl = "/{user}/{repo}/{tag}";
	var urlParts = repoUrl.split('/');
	var branchParts = ref.split('/');
	return xtagJsonUrl.replace('{user}', urlParts[urlParts.length-2])
		.replace('{repo}', urlParts[urlParts.length-1])
		.replace('{tag}', branchParts[branchParts.length-1]);
}

var fetchXtagJson = function(url, callback){
	var host = 'raw.github.com';
	console.log("fetching", "https://" + host + url);
	var http = require('https');
	http.get({
		host: host,
		path: path.join(url, 'xtag.json')
	}, function(res){
		res.setEncoding('utf8');
		if (res.statusCode == 200){
			var data = '';
			res.on('data', function(chuck){
				data += chuck;
			});
			res.on('end', function(){
				try {
					var xtagJson = JSON.parse(sanitize(data).xss());
					xtagJson.xtagJsonRawPath = url;
					callback(null, xtagJson);
				} catch(e) { 
					callback("error parsing xtag.json: " + e + "\n" + data, null);
				}
			});
		} else {
			callback("request returned:" + res.statusCode, null);
		}
	}).on('error', function(err){	
		callback(err,null);
	});
}
