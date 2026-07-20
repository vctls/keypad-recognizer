// ==UserScript==
// @name         Keypad Recognizer — shuffled PIN keypad bridge
// @namespace    https://github.com/vctls/keypad_recog
// @version      0.6.1
// @description  Detects shuffled numeric login keypads and lets a password manager fill a real input that is then "typed" on the virtual keypad by simulating clicks.
// @author       vctls
// @match        *://*/*
// @match        file:///*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @run-at       document-start
// ==/UserScript==
// NOTE: intentionally NOT @noframes. Some banks (e.g. La Banque Postale) serve the login
// keypad inside a cross-origin iframe on a sibling subdomain, so the script must be allowed
// to run in frames to reach it. The whitelist gate (registrable-domain aware) keeps it inert
// in every non-matching frame, and menu registration is limited to the top frame or active
// frames, so removing @noframes does not spam arbitrary ad/tracking iframes.

/*
 * Phase 2. Pipeline: whitelist gate -> detector -> reader -> input bridge -> replayer.
 *
 * Detector (Phase 2): spatial clustering. Broad clickable candidates are grouped into
 * geometric clusters of near-uniform size; digits are read only within promising clusters
 * (cheap, and generic across sites that don't use standard <button>s). A whole-page scan
 * is the fallback. The keypad is the cluster whose readable keys cover 0-9.
 *
 * Reader chain (per key element):
 *   1. text content            (generic text keypads)
 *   2. attributes              (aria-label/title/alt/value/data-*)
 *   3. glyph fingerprint       (image/SVG/canvas digits -> nearest baked reference)
 * OCR (Tesseract) for unknown glyph sets is deferred to a later phase; unknown
 * glyphs fall through to a (future) manual calibration step.
 *
 * Phase 2 also adds: SPA re-detection polish (hide when the keypad disappears;
 * re-check on visibility/pageshow), richer status/error UX, and de-spammed
 * menu-command registration under the dev hot-reload loader.
 *
 * Testability: works as a userscript (GM_* present) OR injected directly for tests
 * (falls back to localStorage; window.__KR__ exposes detect()/typeSecret()/findKeypad()).
 */

(function () {
  "use strict";

  // Idempotent for dev hot-reload: tear down any previous instance before re-init,
  // so re-running the script never stacks duplicate panels / observers.
  if (window.__KR__ && typeof window.__KR__.__teardown === "function") {
    try { window.__KR__.__teardown(); } catch (e) {}
  }

  // ------------------------------------------------------------------ config / storage
  const NS = "kr:";
  const store = {
    get(key, dflt) {
      try {
        if (typeof GM_getValue !== "undefined") return GM_getValue(NS + key, dflt);
        const v = localStorage.getItem(NS + key);
        return v == null ? dflt : JSON.parse(v);
      } catch (e) { return dflt; }
    },
    set(key, val) {
      try {
        if (typeof GM_setValue !== "undefined") return GM_setValue(NS + key, val);
        localStorage.setItem(NS + key, JSON.stringify(val));
      } catch (e) {}
    },
  };

  const origin = location.origin === "null" ? "file://" : location.origin;
  const getWhitelist = () => store.get("whitelist", []);
  const hostOf = (o) => { try { return new URL(o).hostname.replace(/\.+$/, ""); } catch (e) { return ""; } };

  // A frame is enabled when forceEnable is on, its exact origin is whitelisted, OR a whitelisted
  // origin shares this frame's registrable domain (eTLD+1). Domain matching is what makes a bank's
  // login keypad reachable when it is served from a sibling subdomain inside a cross-origin iframe:
  // enabling www.labanquepostale.fr also enables the keypad frame at
  // voscomptesenligne.labanquepostale.fr. eTLD+1 is computed from the embedded Public Suffix List,
  // so multi-level suffixes (foo.co.uk) are handled correctly rather than by a naive 2-label guess.
  const domainWhitelisted = (hostname, wl) => {
    const myDomain = registrableDomain(hostname);
    if (!myDomain) return false;
    return wl.some((o) => registrableDomain(hostOf(o)) === myDomain);
  };
  const isWhitelisted = () => {
    if (store.get("forceEnable", false)) return true;
    const wl = getWhitelist();
    return wl.includes(origin) || domainWhitelisted(location.hostname, wl);
  };

  // Are we the top document, or running inside a frame (e.g. a bank's login keypad served in a
  // cross-origin iframe)? Sub-frames use a COMPACT panel (input + one emoji button) placed clear
  // of the embedded form; the top frame keeps the full panel.
  const isTopFrame = (() => { try { return window.top === window; } catch (e) { return true; } })();
  const COMPACT = !isTopFrame;
  const PANEL_EMOJI = "🔢"; // sole label of the compact panel's action button

  // Registrable domain (eTLD+1) via the Public Suffix List algorithm: the longest matching rule
  // wins; '*' matches exactly one label; a '!' exception takes priority and shortens the public
  // suffix by its leftmost label; an unlisted TLD falls back to the default '*' rule (public
  // suffix = final label). Returns "" when the host has no ownable registrable domain — it is
  // itself a public suffix, a bare IP, or a single label.
  function registrableDomain(host) {
    host = String(host || "").toLowerCase().replace(/\.+$/, "");
    if (!host || host.indexOf(".") === -1) return "";
    if (/^\d+(?:\.\d+){3}$/.test(host)) return host;
    const labels = host.split(".");
    let suffixLen = 1, exceptionLen = 0;
    for (let i = 0; i < labels.length; i++) {
      const rest = labels.slice(i), n = rest.length, rule = rest.join(".");
      if (PSL_RULES.has("!" + rule)) exceptionLen = Math.max(exceptionLen, n - 1);
      if (PSL_RULES.has(rule)) suffixLen = Math.max(suffixLen, n);
      if (n >= 2 && PSL_RULES.has("*." + rest.slice(1).join("."))) suffixLen = Math.max(suffixLen, n);
    }
    const psl = exceptionLen > 0 ? exceptionLen : suffixLen;
    if (labels.length <= psl) return "";
    return labels.slice(labels.length - psl - 1).join(".");
  }

  // ---- Public Suffix List (ICANN section) — regenerate with dev/build-psl.sh ----
  // Source: https://publicsuffix.org/list/public_suffix_list.dat
  // Version: 2026-07-15_18-13-59_UTC   Behavior-affecting rules: 5507
  // Single-label rules are omitted (identical to the PSL default '*' rule).
  const PSL_RULES = new Set((
    "com.ac edu.ac gov.ac mil.ac net.ac org.ac ac.ae co.ae gov.ae mil.ae net.ae org.ae sch.ae airline.aero " +
    "airport.aero accident-investigation.aero accident-prevention.aero aerobatic.aero aeroclub.aero " +
    "aerodrome.aero agents.aero air-surveillance.aero air-traffic-control.aero aircraft.aero airtraffic.aero " +
    "ambulance.aero association.aero author.aero ballooning.aero broker.aero caa.aero cargo.aero catering.aero " +
    "certification.aero championship.aero charter.aero civilaviation.aero club.aero conference.aero " +
    "consultant.aero consulting.aero control.aero council.aero crew.aero design.aero dgca.aero educator.aero " +
    "emergency.aero engine.aero engineer.aero entertainment.aero equipment.aero exchange.aero express.aero " +
    "federation.aero flight.aero freight.aero fuel.aero gliding.aero government.aero groundhandling.aero " +
    "group.aero hanggliding.aero homebuilt.aero insurance.aero journal.aero journalist.aero leasing.aero " +
    "logistics.aero magazine.aero maintenance.aero marketplace.aero media.aero microlight.aero modelling.aero " +
    "navigation.aero parachuting.aero paragliding.aero passenger-association.aero pilot.aero press.aero " +
    "production.aero recreation.aero repbody.aero res.aero research.aero rotorcraft.aero safety.aero " +
    "scientist.aero services.aero show.aero skydiving.aero software.aero student.aero taxi.aero trader.aero " +
    "trading.aero trainer.aero union.aero workinggroup.aero works.aero com.af edu.af gov.af net.af org.af co.ag " +
    "com.ag net.ag nom.ag org.ag com.ai net.ai off.ai org.ai com.al edu.al gov.al mil.al net.al org.al co.am " +
    "com.am commune.am net.am org.am co.ao ed.ao edu.ao gov.ao gv.ao it.ao og.ao org.ao pb.ao bet.ar com.ar " +
    "coop.ar edu.ar gob.ar gov.ar int.ar mil.ar musica.ar mutual.ar net.ar org.ar seg.ar senasa.ar tur.ar " +
    "e164.arpa home.arpa in-addr.arpa ip6.arpa iris.arpa uri.arpa urn.arpa gov.as ac.at sth.ac.at co.at gv.at " +
    "or.at asn.au com.au edu.au gov.au id.au net.au org.au conf.au oz.au act.au nsw.au nt.au qld.au sa.au tas.au " +
    "vic.au wa.au act.edu.au catholic.edu.au nsw.edu.au nt.edu.au qld.edu.au sa.edu.au tas.edu.au vic.edu.au " +
    "wa.edu.au qld.gov.au sa.gov.au tas.gov.au vic.gov.au wa.gov.au com.aw biz.az co.az com.az edu.az gov.az " +
    "info.az int.az mil.az name.az net.az org.az pp.az pro.az com.ba edu.ba gov.ba mil.ba net.ba org.ba biz.bb " +
    "co.bb com.bb edu.bb gov.bb info.bb net.bb org.bb store.bb tv.bb ac.bd ai.bd co.bd com.bd edu.bd gov.bd " +
    "id.bd info.bd it.bd mil.bd net.bd org.bd sch.bd tv.bd ac.be gov.bf 0.bg 1.bg 2.bg 3.bg 4.bg 5.bg 6.bg 7.bg " +
    "8.bg 9.bg a.bg b.bg c.bg d.bg e.bg f.bg g.bg h.bg i.bg j.bg k.bg l.bg m.bg n.bg o.bg p.bg q.bg r.bg s.bg " +
    "t.bg u.bg v.bg w.bg x.bg y.bg z.bg com.bh edu.bh gov.bh net.bh org.bh co.bi com.bi edu.bi or.bi org.bi " +
    "africa.bj agro.bj architectes.bj assur.bj avocats.bj co.bj com.bj eco.bj econo.bj edu.bj info.bj loisirs.bj " +
    "money.bj net.bj org.bj ote.bj restaurant.bj resto.bj tourism.bj univ.bj com.bm edu.bm gov.bm net.bm org.bm " +
    "com.bn edu.bn gov.bn net.bn org.bn com.bo edu.bo gob.bo int.bo mil.bo net.bo org.bo tv.bo web.bo " +
    "academia.bo agro.bo arte.bo blog.bo bolivia.bo ciencia.bo cooperativa.bo democracia.bo deporte.bo " +
    "ecologia.bo economia.bo empresa.bo indigena.bo industria.bo info.bo medicina.bo movimiento.bo musica.bo " +
    "natural.bo nombre.bo noticias.bo patria.bo plurinacional.bo politica.bo profesional.bo pueblo.bo revista.bo " +
    "salud.bo tecnologia.bo tksat.bo transporte.bo wiki.bo 9guacu.br abc.br adm.br adv.br agr.br aju.br am.br " +
    "anani.br aparecida.br api.br app.br arq.br art.br ato.br b.br barueri.br belem.br bet.br bhz.br bib.br " +
    "bio.br blog.br bmd.br boavista.br bsb.br campinagrande.br campinas.br caxias.br cim.br cng.br cnt.br com.br " +
    "contagem.br coop.br coz.br cri.br cuiaba.br curitiba.br def.br des.br det.br dev.br ecn.br eco.br edu.br " +
    "emp.br enf.br eng.br esp.br etc.br eti.br far.br feira.br flog.br floripa.br fm.br fnd.br fortal.br fot.br " +
    "foz.br fst.br g12.br geo.br ggf.br goiania.br gov.br ac.gov.br al.gov.br am.gov.br ap.gov.br ba.gov.br " +
    "ce.gov.br df.gov.br es.gov.br go.gov.br ma.gov.br mg.gov.br ms.gov.br mt.gov.br pa.gov.br pb.gov.br " +
    "pe.gov.br pi.gov.br pr.gov.br rj.gov.br rn.gov.br ro.gov.br rr.gov.br rs.gov.br sc.gov.br se.gov.br " +
    "sp.gov.br to.gov.br gru.br ia.br imb.br ind.br inf.br jab.br jampa.br jdf.br joinville.br jor.br jus.br " +
    "leg.br leilao.br lel.br log.br londrina.br macapa.br maceio.br manaus.br maringa.br mat.br med.br mil.br " +
    "morena.br mp.br mus.br natal.br net.br niteroi.br *.nom.br not.br ntr.br odo.br ong.br org.br osasco.br " +
    "palmas.br poa.br ppg.br pro.br psc.br psi.br pvh.br qsl.br radio.br rec.br recife.br rep.br ribeirao.br " +
    "rio.br riobranco.br riopreto.br salvador.br sampa.br santamaria.br santoandre.br saobernardo.br saogonca.br " +
    "seg.br sjc.br slg.br slz.br social.br sorocaba.br srv.br taxi.br tc.br tec.br teo.br the.br tmp.br trd.br " +
    "tur.br tv.br udi.br vet.br vix.br vlog.br wiki.br xyz.br zlg.br com.bs edu.bs gov.bs net.bs org.bs com.bt " +
    "edu.bt gov.bt net.bt org.bt ac.bw co.bw gov.bw net.bw org.bw gov.by mil.by com.by of.by co.bz com.bz edu.bz " +
    "gov.bz net.bz org.bz ab.ca bc.ca mb.ca nb.ca nf.ca nl.ca ns.ca nt.ca nu.ca on.ca pe.ca qc.ca sk.ca yk.ca " +
    "gc.ca gov.cd ac.ci aéroport.ci asso.ci co.ci com.ci ed.ci edu.ci go.ci gouv.ci int.ci net.ci or.ci org.ci " +
    "*.ck !www.ck co.cl gob.cl gov.cl mil.cl co.cm com.cm gov.cm net.cm ac.cn com.cn edu.cn gov.cn mil.cn net.cn " +
    "org.cn 公司.cn 網絡.cn 网络.cn ah.cn bj.cn cq.cn fj.cn gd.cn gs.cn gx.cn gz.cn ha.cn hb.cn he.cn " +
    "hi.cn hk.cn hl.cn hn.cn jl.cn js.cn jx.cn ln.cn mo.cn nm.cn nx.cn qh.cn sc.cn sd.cn sh.cn sn.cn sx.cn tj.cn " +
    "tw.cn xj.cn xz.cn yn.cn zj.cn com.co edu.co gov.co mil.co net.co nom.co org.co ac.cr co.cr ed.cr fi.cr " +
    "go.cr or.cr sa.cr com.cu edu.cu gob.cu inf.cu nat.cu net.cu org.cu com.cv edu.cv id.cv int.cv net.cv " +
    "nome.cv org.cv publ.cv com.cw edu.cw net.cw org.cw gov.cx ac.cy biz.cy com.cy ekloges.cy gov.cy ltd.cy " +
    "mil.cy net.cy org.cy press.cy pro.cy tm.cy gov.cz co.dm com.dm edu.dm gov.dm net.dm org.dm art.do com.do " +
    "edu.do gob.do gov.do mil.do net.do org.do sld.do web.do art.dz asso.dz com.dz edu.dz gov.dz net.dz org.dz " +
    "pol.dz soc.dz tm.dz abg.ec adm.ec agron.ec arqt.ec art.ec bar.ec chef.ec com.ec cont.ec cpa.ec cue.ec " +
    "dent.ec dgn.ec disco.ec doc.ec edu.ec eng.ec esm.ec fin.ec fot.ec gal.ec gob.ec gov.ec gye.ec ibr.ec " +
    "info.ec k12.ec lat.ec loj.ec med.ec mil.ec mktg.ec mon.ec net.ec ntr.ec odont.ec org.ec pro.ec prof.ec " +
    "psic.ec psiq.ec pub.ec rio.ec rrpp.ec sal.ec tech.ec tul.ec tur.ec uio.ec vet.ec xxx.ec aip.ee com.ee " +
    "edu.ee fie.ee gov.ee lib.ee med.ee org.ee pri.ee riik.ee ac.eg com.eg edu.eg eun.eg gov.eg info.eg me.eg " +
    "mil.eg name.eg net.eg org.eg sci.eg sport.eg tv.eg *.er com.es edu.es gob.es nom.es org.es biz.et com.et " +
    "edu.et gov.et info.et name.et net.et org.et aland.fi ac.fj biz.fj com.fj edu.fj gov.fj id.fj info.fj mil.fj " +
    "name.fj net.fj org.fj pro.fj *.fk com.fm edu.fm net.fm org.fm asso.fr com.fr gouv.fr nom.fr prd.fr tm.fr " +
    "avoues.fr cci.fr greta.fr huissier-justice.fr edu.gd gov.gd com.ge cyb.ge edu.ge gov.ge llc.ge net.ge " +
    "online.ge org.ge pvt.ge school.ge tnx.ge co.gg net.gg org.gg biz.gh com.gh edu.gh gov.gh mil.gh net.gh " +
    "org.gh com.gi edu.gi gov.gi ltd.gi mod.gi org.gi co.gl com.gl edu.gl net.gl org.gl ac.gn com.gn edu.gn " +
    "gov.gn net.gn org.gn asso.gp com.gp edu.gp mobi.gp net.gp org.gp com.gr edu.gr gov.gr net.gr org.gr com.gt " +
    "edu.gt gob.gt ind.gt mil.gt net.gt org.gt com.gu edu.gu gov.gu guam.gu info.gu net.gu org.gu web.gu co.gy " +
    "com.gy edu.gy gov.gy net.gy org.gy com.hk edu.hk gov.hk idv.hk net.hk org.hk 个人.hk 個人.hk 公司.hk " +
    "政府.hk 敎育.hk 教育.hk 箇人.hk 組織.hk 組织.hk 網絡.hk 網络.hk 组織.hk 组织.hk " +
    "网絡.hk 网络.hk com.hn edu.hn gob.hn mil.hn net.hn org.hn com.hr from.hr iz.hr name.hr adult.ht art.ht " +
    "asso.ht com.ht coop.ht edu.ht firm.ht gouv.ht info.ht med.ht net.ht org.ht perso.ht pol.ht pro.ht rel.ht " +
    "shop.ht 2000.hu agrar.hu bolt.hu casino.hu city.hu co.hu erotica.hu erotika.hu film.hu forum.hu games.hu " +
    "hotel.hu info.hu ingatlan.hu jogasz.hu konyvelo.hu lakas.hu media.hu news.hu org.hu priv.hu reklam.hu " +
    "sex.hu shop.hu sport.hu suli.hu szex.hu tm.hu tozsde.hu utazas.hu video.hu ac.id ai.id biz.id co.id desa.id " +
    "go.id kop.id mil.id my.id net.id or.id ponpes.id sch.id web.id ᬩᬮᬶ.id gov.ie ac.il co.il gov.il " +
    "idf.il k12.il muni.il net.il org.il אקדמיה.ישראל ישוב.ישראל צהל.ישראל " +
    "ממשל.ישראל ac.im co.im ltd.co.im plc.co.im com.im net.im org.im tt.im tv.im 5g.in 6g.in ac.in " +
    "aero.in ai.in alumni.in am.in bank.in bihar.in biz.in business.in ca.in cn.in co.in com.in coop.in cs.in " +
    "delhi.in dr.in edu.in er.in fin.in firm.in gen.in gov.in gujarat.in ind.in info.in int.in internet.in io.in " +
    "me.in mil.in net.in nic.in org.in pg.in post.in pro.in res.in school.in travel.in tv.in ub.in uk.in up.in " +
    "us.in eu.int co.io com.io edu.io gov.io mil.io net.io nom.io org.io com.iq edu.iq gov.iq mil.iq net.iq " +
    "org.iq ac.ir co.ir gov.ir id.ir net.ir org.ir sch.ir ایران.ir ايران.ir edu.it gov.it abr.it " +
    "abruzzo.it aosta-valley.it aostavalley.it bas.it basilicata.it cal.it calabria.it cam.it campania.it " +
    "emilia-romagna.it emiliaromagna.it emr.it friuli-v-giulia.it friuli-ve-giulia.it friuli-vegiulia.it " +
    "friuli-venezia-giulia.it friuli-veneziagiulia.it friuli-vgiulia.it friuliv-giulia.it friulive-giulia.it " +
    "friulivegiulia.it friulivenezia-giulia.it friuliveneziagiulia.it friulivgiulia.it fvg.it laz.it lazio.it " +
    "lig.it liguria.it lom.it lombardia.it lombardy.it lucania.it mar.it marche.it mol.it molise.it piedmont.it " +
    "piemonte.it pmn.it pug.it puglia.it sar.it sardegna.it sardinia.it sic.it sicilia.it sicily.it taa.it " +
    "tos.it toscana.it trentin-sud-tirol.it trentin-süd-tirol.it trentin-sudtirol.it trentin-südtirol.it " +
    "trentin-sued-tirol.it trentin-suedtirol.it trentino.it trentino-a-adige.it trentino-aadige.it " +
    "trentino-alto-adige.it trentino-altoadige.it trentino-s-tirol.it trentino-stirol.it trentino-sud-tirol.it " +
    "trentino-süd-tirol.it trentino-sudtirol.it trentino-südtirol.it trentino-sued-tirol.it " +
    "trentino-suedtirol.it trentinoa-adige.it trentinoaadige.it trentinoalto-adige.it trentinoaltoadige.it " +
    "trentinos-tirol.it trentinostirol.it trentinosud-tirol.it trentinosüd-tirol.it trentinosudtirol.it " +
    "trentinosüdtirol.it trentinosued-tirol.it trentinosuedtirol.it trentinsud-tirol.it trentinsüd-tirol.it " +
    "trentinsudtirol.it trentinsüdtirol.it trentinsued-tirol.it trentinsuedtirol.it tuscany.it umb.it umbria.it " +
    "val-d-aosta.it val-daosta.it vald-aosta.it valdaosta.it valle-aosta.it valle-d-aosta.it valle-daosta.it " +
    "valleaosta.it valled-aosta.it valledaosta.it vallee-aoste.it vallée-aoste.it vallee-d-aoste.it " +
    "vallée-d-aoste.it valleeaoste.it valléeaoste.it valleedaoste.it valléedaoste.it vao.it vda.it ven.it " +
    "veneto.it ag.it agrigento.it al.it alessandria.it alto-adige.it altoadige.it an.it ancona.it " +
    "andria-barletta-trani.it andria-trani-barletta.it andriabarlettatrani.it andriatranibarletta.it ao.it " +
    "aosta.it aoste.it ap.it aq.it aquila.it ar.it arezzo.it ascoli-piceno.it ascolipiceno.it asti.it at.it " +
    "av.it avellino.it ba.it balsan.it balsan-sudtirol.it balsan-südtirol.it balsan-suedtirol.it bari.it " +
    "barletta-trani-andria.it barlettatraniandria.it belluno.it benevento.it bergamo.it bg.it bi.it biella.it " +
    "bl.it bn.it bo.it bologna.it bolzano.it bolzano-altoadige.it bozen.it bozen-sudtirol.it bozen-südtirol.it " +
    "bozen-suedtirol.it br.it brescia.it brindisi.it bs.it bt.it bulsan.it bulsan-sudtirol.it " +
    "bulsan-südtirol.it bulsan-suedtirol.it bz.it ca.it cagliari.it caltanissetta.it campidano-medio.it " +
    "campidanomedio.it campobasso.it carbonia-iglesias.it carboniaiglesias.it carrara-massa.it carraramassa.it " +
    "caserta.it catania.it catanzaro.it cb.it ce.it cesena-forli.it cesena-forlì.it cesenaforli.it " +
    "cesenaforlì.it ch.it chieti.it ci.it cl.it cn.it co.it como.it cosenza.it cr.it cremona.it crotone.it " +
    "cs.it ct.it cuneo.it cz.it dell-ogliastra.it dellogliastra.it en.it enna.it fc.it fe.it fermo.it ferrara.it " +
    "fg.it fi.it firenze.it florence.it fm.it foggia.it forli-cesena.it forlì-cesena.it forlicesena.it " +
    "forlìcesena.it fr.it frosinone.it ge.it genoa.it genova.it go.it gorizia.it gr.it grosseto.it " +
    "iglesias-carbonia.it iglesiascarbonia.it im.it imperia.it is.it isernia.it kr.it la-spezia.it laquila.it " +
    "laspezia.it latina.it lc.it le.it lecce.it lecco.it li.it livorno.it lo.it lodi.it lt.it lu.it lucca.it " +
    "macerata.it mantova.it massa-carrara.it massacarrara.it matera.it mb.it mc.it me.it medio-campidano.it " +
    "mediocampidano.it messina.it mi.it milan.it milano.it mn.it mo.it modena.it monza.it monza-brianza.it " +
    "monza-e-della-brianza.it monzabrianza.it monzaebrianza.it monzaedellabrianza.it ms.it mt.it na.it naples.it " +
    "napoli.it no.it novara.it nu.it nuoro.it og.it ogliastra.it olbia-tempio.it olbiatempio.it or.it " +
    "oristano.it ot.it pa.it padova.it padua.it palermo.it parma.it pavia.it pc.it pd.it pe.it perugia.it " +
    "pesaro-urbino.it pesarourbino.it pescara.it pg.it pi.it piacenza.it pisa.it pistoia.it pn.it po.it " +
    "pordenone.it potenza.it pr.it prato.it pt.it pu.it pv.it pz.it ra.it ragusa.it ravenna.it rc.it re.it " +
    "reggio-calabria.it reggio-emilia.it reggiocalabria.it reggioemilia.it rg.it ri.it rieti.it rimini.it rm.it " +
    "rn.it ro.it roma.it rome.it rovigo.it sa.it salerno.it sassari.it savona.it si.it siena.it siracusa.it " +
    "so.it sondrio.it sp.it sr.it ss.it südtirol.it suedtirol.it sv.it ta.it taranto.it te.it tempio-olbia.it " +
    "tempioolbia.it teramo.it terni.it tn.it to.it torino.it tp.it tr.it trani-andria-barletta.it " +
    "trani-barletta-andria.it traniandriabarletta.it tranibarlettaandria.it trapani.it trento.it treviso.it " +
    "trieste.it ts.it turin.it tv.it ud.it udine.it urbino-pesaro.it urbinopesaro.it va.it varese.it vb.it vc.it " +
    "ve.it venezia.it venice.it verbania.it vercelli.it verona.it vi.it vibo-valentia.it vibovalentia.it " +
    "vicenza.it viterbo.it vr.it vs.it vt.it vv.it co.je net.je org.je *.jm agri.jo ai.jo com.jo edu.jo eng.jo " +
    "fm.jo gov.jo mil.jo net.jo org.jo per.jo phd.jo sch.jo tv.jo ac.jp ad.jp co.jp ed.jp go.jp gr.jp lg.jp " +
    "ne.jp or.jp aichi.jp akita.jp aomori.jp chiba.jp ehime.jp fukui.jp fukuoka.jp fukushima.jp gifu.jp gunma.jp " +
    "hiroshima.jp hokkaido.jp hyogo.jp ibaraki.jp ishikawa.jp iwate.jp kagawa.jp kagoshima.jp kanagawa.jp " +
    "kochi.jp kumamoto.jp kyoto.jp mie.jp miyagi.jp miyazaki.jp nagano.jp nagasaki.jp nara.jp niigata.jp oita.jp " +
    "okayama.jp okinawa.jp osaka.jp saga.jp saitama.jp shiga.jp shimane.jp shizuoka.jp tochigi.jp tokushima.jp " +
    "tokyo.jp tottori.jp toyama.jp wakayama.jp yamagata.jp yamaguchi.jp yamanashi.jp 三重.jp 京都.jp " +
    "佐賀.jp 兵庫.jp 北海道.jp 千葉.jp 和歌山.jp 埼玉.jp 大分.jp 大阪.jp 奈良.jp 宮城.jp " +
    "宮崎.jp 富山.jp 山口.jp 山形.jp 山梨.jp 岐阜.jp 岡山.jp 岩手.jp 島根.jp 広島.jp " +
    "徳島.jp 愛媛.jp 愛知.jp 新潟.jp 東京.jp 栃木.jp 沖縄.jp 滋賀.jp 熊本.jp 石川.jp " +
    "神奈川.jp 福井.jp 福岡.jp 福島.jp 秋田.jp 群馬.jp 茨城.jp 長崎.jp 長野.jp 青森.jp " +
    "静岡.jp 香川.jp 高知.jp 鳥取.jp 鹿児島.jp *.kawasaki.jp !city.kawasaki.jp *.kitakyushu.jp " +
    "!city.kitakyushu.jp *.kobe.jp !city.kobe.jp *.nagoya.jp !city.nagoya.jp *.sapporo.jp !city.sapporo.jp " +
    "*.sendai.jp !city.sendai.jp *.yokohama.jp !city.yokohama.jp aisai.aichi.jp ama.aichi.jp anjo.aichi.jp " +
    "asuke.aichi.jp chiryu.aichi.jp chita.aichi.jp fuso.aichi.jp gamagori.aichi.jp handa.aichi.jp hazu.aichi.jp " +
    "hekinan.aichi.jp higashiura.aichi.jp ichinomiya.aichi.jp inazawa.aichi.jp inuyama.aichi.jp isshiki.aichi.jp " +
    "iwakura.aichi.jp kanie.aichi.jp kariya.aichi.jp kasugai.aichi.jp kira.aichi.jp kiyosu.aichi.jp " +
    "komaki.aichi.jp konan.aichi.jp kota.aichi.jp mihama.aichi.jp miyoshi.aichi.jp nishio.aichi.jp " +
    "nisshin.aichi.jp obu.aichi.jp oguchi.aichi.jp oharu.aichi.jp okazaki.aichi.jp owariasahi.aichi.jp " +
    "seto.aichi.jp shikatsu.aichi.jp shinshiro.aichi.jp shitara.aichi.jp tahara.aichi.jp takahama.aichi.jp " +
    "tobishima.aichi.jp toei.aichi.jp togo.aichi.jp tokai.aichi.jp tokoname.aichi.jp toyoake.aichi.jp " +
    "toyohashi.aichi.jp toyokawa.aichi.jp toyone.aichi.jp toyota.aichi.jp tsushima.aichi.jp yatomi.aichi.jp " +
    "akita.akita.jp daisen.akita.jp fujisato.akita.jp gojome.akita.jp hachirogata.akita.jp happou.akita.jp " +
    "higashinaruse.akita.jp honjo.akita.jp honjyo.akita.jp ikawa.akita.jp kamikoani.akita.jp kamioka.akita.jp " +
    "katagami.akita.jp kazuno.akita.jp kitaakita.akita.jp kosaka.akita.jp kyowa.akita.jp misato.akita.jp " +
    "mitane.akita.jp moriyoshi.akita.jp nikaho.akita.jp noshiro.akita.jp odate.akita.jp oga.akita.jp " +
    "ogata.akita.jp semboku.akita.jp yokote.akita.jp yurihonjo.akita.jp aomori.aomori.jp gonohe.aomori.jp " +
    "hachinohe.aomori.jp hashikami.aomori.jp hiranai.aomori.jp hirosaki.aomori.jp itayanagi.aomori.jp " +
    "kuroishi.aomori.jp misawa.aomori.jp mutsu.aomori.jp nakadomari.aomori.jp noheji.aomori.jp oirase.aomori.jp " +
    "owani.aomori.jp rokunohe.aomori.jp sannohe.aomori.jp shichinohe.aomori.jp shingo.aomori.jp takko.aomori.jp " +
    "towada.aomori.jp tsugaru.aomori.jp tsuruta.aomori.jp abiko.chiba.jp asahi.chiba.jp chonan.chiba.jp " +
    "chosei.chiba.jp choshi.chiba.jp chuo.chiba.jp funabashi.chiba.jp futtsu.chiba.jp hanamigawa.chiba.jp " +
    "ichihara.chiba.jp ichikawa.chiba.jp ichinomiya.chiba.jp inzai.chiba.jp isumi.chiba.jp kamagaya.chiba.jp " +
    "kamogawa.chiba.jp kashiwa.chiba.jp katori.chiba.jp katsuura.chiba.jp kimitsu.chiba.jp kisarazu.chiba.jp " +
    "kozaki.chiba.jp kujukuri.chiba.jp kyonan.chiba.jp matsudo.chiba.jp midori.chiba.jp mihama.chiba.jp " +
    "minamiboso.chiba.jp mobara.chiba.jp mutsuzawa.chiba.jp nagara.chiba.jp nagareyama.chiba.jp " +
    "narashino.chiba.jp narita.chiba.jp noda.chiba.jp oamishirasato.chiba.jp omigawa.chiba.jp onjuku.chiba.jp " +
    "otaki.chiba.jp sakae.chiba.jp sakura.chiba.jp shimofusa.chiba.jp shirako.chiba.jp shiroi.chiba.jp " +
    "shisui.chiba.jp sodegaura.chiba.jp sosa.chiba.jp tako.chiba.jp tateyama.chiba.jp togane.chiba.jp " +
    "tohnosho.chiba.jp tomisato.chiba.jp urayasu.chiba.jp yachimata.chiba.jp yachiyo.chiba.jp " +
    "yokaichiba.chiba.jp yokoshibahikari.chiba.jp yotsukaido.chiba.jp ainan.ehime.jp honai.ehime.jp " +
    "ikata.ehime.jp imabari.ehime.jp iyo.ehime.jp kamijima.ehime.jp kihoku.ehime.jp kumakogen.ehime.jp " +
    "masaki.ehime.jp matsuno.ehime.jp matsuyama.ehime.jp namikata.ehime.jp niihama.ehime.jp ozu.ehime.jp " +
    "saijo.ehime.jp seiyo.ehime.jp shikokuchuo.ehime.jp tobe.ehime.jp toon.ehime.jp uchiko.ehime.jp " +
    "uwajima.ehime.jp yawatahama.ehime.jp echizen.fukui.jp eiheiji.fukui.jp fukui.fukui.jp ikeda.fukui.jp " +
    "katsuyama.fukui.jp mihama.fukui.jp minamiechizen.fukui.jp obama.fukui.jp ohi.fukui.jp ono.fukui.jp " +
    "sabae.fukui.jp sakai.fukui.jp takahama.fukui.jp tsuruga.fukui.jp wakasa.fukui.jp ashiya.fukuoka.jp " +
    "buzen.fukuoka.jp chikugo.fukuoka.jp chikuho.fukuoka.jp chikujo.fukuoka.jp chikushino.fukuoka.jp " +
    "chikuzen.fukuoka.jp chuo.fukuoka.jp dazaifu.fukuoka.jp fukuchi.fukuoka.jp hakata.fukuoka.jp " +
    "higashi.fukuoka.jp hirokawa.fukuoka.jp hisayama.fukuoka.jp iizuka.fukuoka.jp inatsuki.fukuoka.jp " +
    "kaho.fukuoka.jp kasuga.fukuoka.jp kasuya.fukuoka.jp kawara.fukuoka.jp keisen.fukuoka.jp koga.fukuoka.jp " +
    "kurate.fukuoka.jp kurogi.fukuoka.jp kurume.fukuoka.jp minami.fukuoka.jp miyako.fukuoka.jp miyama.fukuoka.jp " +
    "miyawaka.fukuoka.jp mizumaki.fukuoka.jp munakata.fukuoka.jp nakagawa.fukuoka.jp nakama.fukuoka.jp " +
    "nishi.fukuoka.jp nogata.fukuoka.jp ogori.fukuoka.jp okagaki.fukuoka.jp okawa.fukuoka.jp oki.fukuoka.jp " +
    "omuta.fukuoka.jp onga.fukuoka.jp onojo.fukuoka.jp oto.fukuoka.jp saigawa.fukuoka.jp sasaguri.fukuoka.jp " +
    "shingu.fukuoka.jp shinyoshitomi.fukuoka.jp shonai.fukuoka.jp soeda.fukuoka.jp sue.fukuoka.jp " +
    "tachiarai.fukuoka.jp tagawa.fukuoka.jp takata.fukuoka.jp toho.fukuoka.jp toyotsu.fukuoka.jp " +
    "tsuiki.fukuoka.jp ukiha.fukuoka.jp umi.fukuoka.jp usui.fukuoka.jp yamada.fukuoka.jp yame.fukuoka.jp " +
    "yanagawa.fukuoka.jp yukuhashi.fukuoka.jp aizubange.fukushima.jp aizumisato.fukushima.jp " +
    "aizuwakamatsu.fukushima.jp asakawa.fukushima.jp bandai.fukushima.jp date.fukushima.jp " +
    "fukushima.fukushima.jp furudono.fukushima.jp futaba.fukushima.jp hanawa.fukushima.jp higashi.fukushima.jp " +
    "hirata.fukushima.jp hirono.fukushima.jp iitate.fukushima.jp inawashiro.fukushima.jp ishikawa.fukushima.jp " +
    "iwaki.fukushima.jp izumizaki.fukushima.jp kagamiishi.fukushima.jp kaneyama.fukushima.jp " +
    "kawamata.fukushima.jp kitakata.fukushima.jp kitashiobara.fukushima.jp koori.fukushima.jp " +
    "koriyama.fukushima.jp kunimi.fukushima.jp miharu.fukushima.jp mishima.fukushima.jp namie.fukushima.jp " +
    "nango.fukushima.jp nishiaizu.fukushima.jp nishigo.fukushima.jp okuma.fukushima.jp omotego.fukushima.jp " +
    "ono.fukushima.jp otama.fukushima.jp samegawa.fukushima.jp shimogo.fukushima.jp shirakawa.fukushima.jp " +
    "showa.fukushima.jp soma.fukushima.jp sukagawa.fukushima.jp taishin.fukushima.jp tamakawa.fukushima.jp " +
    "tanagura.fukushima.jp tenei.fukushima.jp yabuki.fukushima.jp yamato.fukushima.jp yamatsuri.fukushima.jp " +
    "yanaizu.fukushima.jp yugawa.fukushima.jp anpachi.gifu.jp ena.gifu.jp gifu.gifu.jp ginan.gifu.jp " +
    "godo.gifu.jp gujo.gifu.jp hashima.gifu.jp hichiso.gifu.jp hida.gifu.jp higashishirakawa.gifu.jp " +
    "ibigawa.gifu.jp ikeda.gifu.jp kakamigahara.gifu.jp kani.gifu.jp kasahara.gifu.jp kasamatsu.gifu.jp " +
    "kawaue.gifu.jp kitagata.gifu.jp mino.gifu.jp minokamo.gifu.jp mitake.gifu.jp mizunami.gifu.jp " +
    "motosu.gifu.jp nakatsugawa.gifu.jp ogaki.gifu.jp sakahogi.gifu.jp seki.gifu.jp sekigahara.gifu.jp " +
    "shirakawa.gifu.jp tajimi.gifu.jp takayama.gifu.jp tarui.gifu.jp toki.gifu.jp tomika.gifu.jp " +
    "wanouchi.gifu.jp yamagata.gifu.jp yaotsu.gifu.jp yoro.gifu.jp annaka.gunma.jp chiyoda.gunma.jp " +
    "fujioka.gunma.jp higashiagatsuma.gunma.jp isesaki.gunma.jp itakura.gunma.jp kanna.gunma.jp kanra.gunma.jp " +
    "katashina.gunma.jp kawaba.gunma.jp kiryu.gunma.jp kusatsu.gunma.jp maebashi.gunma.jp meiwa.gunma.jp " +
    "midori.gunma.jp minakami.gunma.jp naganohara.gunma.jp nakanojo.gunma.jp nanmoku.gunma.jp numata.gunma.jp " +
    "oizumi.gunma.jp ora.gunma.jp ota.gunma.jp shibukawa.gunma.jp shimonita.gunma.jp shinto.gunma.jp " +
    "showa.gunma.jp takasaki.gunma.jp takayama.gunma.jp tamamura.gunma.jp tatebayashi.gunma.jp tomioka.gunma.jp " +
    "tsukiyono.gunma.jp tsumagoi.gunma.jp ueno.gunma.jp yoshioka.gunma.jp asaminami.hiroshima.jp " +
    "daiwa.hiroshima.jp etajima.hiroshima.jp fuchu.hiroshima.jp fukuyama.hiroshima.jp hatsukaichi.hiroshima.jp " +
    "higashihiroshima.hiroshima.jp hongo.hiroshima.jp jinsekikogen.hiroshima.jp kaita.hiroshima.jp " +
    "kui.hiroshima.jp kumano.hiroshima.jp kure.hiroshima.jp mihara.hiroshima.jp miyoshi.hiroshima.jp " +
    "naka.hiroshima.jp onomichi.hiroshima.jp osakikamijima.hiroshima.jp otake.hiroshima.jp saka.hiroshima.jp " +
    "sera.hiroshima.jp seranishi.hiroshima.jp shinichi.hiroshima.jp shobara.hiroshima.jp takehara.hiroshima.jp " +
    "abashiri.hokkaido.jp abira.hokkaido.jp aibetsu.hokkaido.jp akabira.hokkaido.jp akkeshi.hokkaido.jp " +
    "asahikawa.hokkaido.jp ashibetsu.hokkaido.jp ashoro.hokkaido.jp assabu.hokkaido.jp atsuma.hokkaido.jp " +
    "bibai.hokkaido.jp biei.hokkaido.jp bifuka.hokkaido.jp bihoro.hokkaido.jp biratori.hokkaido.jp " +
    "chippubetsu.hokkaido.jp chitose.hokkaido.jp date.hokkaido.jp ebetsu.hokkaido.jp embetsu.hokkaido.jp " +
    "eniwa.hokkaido.jp erimo.hokkaido.jp esan.hokkaido.jp esashi.hokkaido.jp fukagawa.hokkaido.jp " +
    "fukushima.hokkaido.jp furano.hokkaido.jp furubira.hokkaido.jp haboro.hokkaido.jp hakodate.hokkaido.jp " +
    "hamatonbetsu.hokkaido.jp hidaka.hokkaido.jp higashikagura.hokkaido.jp higashikawa.hokkaido.jp " +
    "hiroo.hokkaido.jp hokuryu.hokkaido.jp hokuto.hokkaido.jp honbetsu.hokkaido.jp horokanai.hokkaido.jp " +
    "horonobe.hokkaido.jp ikeda.hokkaido.jp imakane.hokkaido.jp ishikari.hokkaido.jp iwamizawa.hokkaido.jp " +
    "iwanai.hokkaido.jp kamifurano.hokkaido.jp kamikawa.hokkaido.jp kamishihoro.hokkaido.jp " +
    "kamisunagawa.hokkaido.jp kamoenai.hokkaido.jp kayabe.hokkaido.jp kembuchi.hokkaido.jp kikonai.hokkaido.jp " +
    "kimobetsu.hokkaido.jp kitahiroshima.hokkaido.jp kitami.hokkaido.jp kiyosato.hokkaido.jp " +
    "koshimizu.hokkaido.jp kunneppu.hokkaido.jp kuriyama.hokkaido.jp kuromatsunai.hokkaido.jp " +
    "kushiro.hokkaido.jp kutchan.hokkaido.jp kyowa.hokkaido.jp mashike.hokkaido.jp matsumae.hokkaido.jp " +
    "mikasa.hokkaido.jp minamifurano.hokkaido.jp mombetsu.hokkaido.jp moseushi.hokkaido.jp mukawa.hokkaido.jp " +
    "muroran.hokkaido.jp naie.hokkaido.jp nakagawa.hokkaido.jp nakasatsunai.hokkaido.jp nakatombetsu.hokkaido.jp " +
    "nanae.hokkaido.jp nanporo.hokkaido.jp nayoro.hokkaido.jp nemuro.hokkaido.jp niikappu.hokkaido.jp " +
    "niki.hokkaido.jp nishiokoppe.hokkaido.jp noboribetsu.hokkaido.jp numata.hokkaido.jp obihiro.hokkaido.jp " +
    "obira.hokkaido.jp oketo.hokkaido.jp okoppe.hokkaido.jp otaru.hokkaido.jp otobe.hokkaido.jp " +
    "otofuke.hokkaido.jp otoineppu.hokkaido.jp oumu.hokkaido.jp ozora.hokkaido.jp pippu.hokkaido.jp " +
    "rankoshi.hokkaido.jp rebun.hokkaido.jp rikubetsu.hokkaido.jp rishiri.hokkaido.jp rishirifuji.hokkaido.jp " +
    "saroma.hokkaido.jp sarufutsu.hokkaido.jp shakotan.hokkaido.jp shari.hokkaido.jp shibecha.hokkaido.jp " +
    "shibetsu.hokkaido.jp shikabe.hokkaido.jp shikaoi.hokkaido.jp shimamaki.hokkaido.jp shimizu.hokkaido.jp " +
    "shimokawa.hokkaido.jp shinshinotsu.hokkaido.jp shintoku.hokkaido.jp shiranuka.hokkaido.jp " +
    "shiraoi.hokkaido.jp shiriuchi.hokkaido.jp sobetsu.hokkaido.jp sunagawa.hokkaido.jp taiki.hokkaido.jp " +
    "takasu.hokkaido.jp takikawa.hokkaido.jp takinoue.hokkaido.jp teshikaga.hokkaido.jp tobetsu.hokkaido.jp " +
    "tohma.hokkaido.jp tomakomai.hokkaido.jp tomari.hokkaido.jp toya.hokkaido.jp toyako.hokkaido.jp " +
    "toyotomi.hokkaido.jp toyoura.hokkaido.jp tsubetsu.hokkaido.jp tsukigata.hokkaido.jp urakawa.hokkaido.jp " +
    "urausu.hokkaido.jp uryu.hokkaido.jp utashinai.hokkaido.jp wakkanai.hokkaido.jp wassamu.hokkaido.jp " +
    "yakumo.hokkaido.jp yoichi.hokkaido.jp aioi.hyogo.jp akashi.hyogo.jp ako.hyogo.jp amagasaki.hyogo.jp " +
    "aogaki.hyogo.jp asago.hyogo.jp ashiya.hyogo.jp awaji.hyogo.jp fukusaki.hyogo.jp goshiki.hyogo.jp " +
    "harima.hyogo.jp himeji.hyogo.jp ichikawa.hyogo.jp inagawa.hyogo.jp itami.hyogo.jp kakogawa.hyogo.jp " +
    "kamigori.hyogo.jp kamikawa.hyogo.jp kasai.hyogo.jp kasuga.hyogo.jp kawanishi.hyogo.jp miki.hyogo.jp " +
    "minamiawaji.hyogo.jp nishinomiya.hyogo.jp nishiwaki.hyogo.jp ono.hyogo.jp sanda.hyogo.jp sannan.hyogo.jp " +
    "sasayama.hyogo.jp sayo.hyogo.jp shingu.hyogo.jp shinonsen.hyogo.jp shiso.hyogo.jp sumoto.hyogo.jp " +
    "taishi.hyogo.jp taka.hyogo.jp takarazuka.hyogo.jp takasago.hyogo.jp takino.hyogo.jp tamba.hyogo.jp " +
    "tatsuno.hyogo.jp toyooka.hyogo.jp yabu.hyogo.jp yashiro.hyogo.jp yoka.hyogo.jp yokawa.hyogo.jp " +
    "ami.ibaraki.jp asahi.ibaraki.jp bando.ibaraki.jp chikusei.ibaraki.jp daigo.ibaraki.jp fujishiro.ibaraki.jp " +
    "hitachi.ibaraki.jp hitachinaka.ibaraki.jp hitachiomiya.ibaraki.jp hitachiota.ibaraki.jp ibaraki.ibaraki.jp " +
    "ina.ibaraki.jp inashiki.ibaraki.jp itako.ibaraki.jp iwama.ibaraki.jp joso.ibaraki.jp kamisu.ibaraki.jp " +
    "kasama.ibaraki.jp kashima.ibaraki.jp kasumigaura.ibaraki.jp koga.ibaraki.jp miho.ibaraki.jp mito.ibaraki.jp " +
    "moriya.ibaraki.jp naka.ibaraki.jp namegata.ibaraki.jp oarai.ibaraki.jp ogawa.ibaraki.jp omitama.ibaraki.jp " +
    "ryugasaki.ibaraki.jp sakai.ibaraki.jp sakuragawa.ibaraki.jp shimodate.ibaraki.jp shimotsuma.ibaraki.jp " +
    "shirosato.ibaraki.jp sowa.ibaraki.jp suifu.ibaraki.jp takahagi.ibaraki.jp tamatsukuri.ibaraki.jp " +
    "tokai.ibaraki.jp tomobe.ibaraki.jp tone.ibaraki.jp toride.ibaraki.jp tsuchiura.ibaraki.jp " +
    "tsukuba.ibaraki.jp uchihara.ibaraki.jp ushiku.ibaraki.jp yachiyo.ibaraki.jp yamagata.ibaraki.jp " +
    "yawara.ibaraki.jp yuki.ibaraki.jp anamizu.ishikawa.jp hakui.ishikawa.jp hakusan.ishikawa.jp " +
    "kaga.ishikawa.jp kahoku.ishikawa.jp kanazawa.ishikawa.jp kawakita.ishikawa.jp komatsu.ishikawa.jp " +
    "nakanoto.ishikawa.jp nanao.ishikawa.jp nomi.ishikawa.jp nonoichi.ishikawa.jp noto.ishikawa.jp " +
    "shika.ishikawa.jp suzu.ishikawa.jp tsubata.ishikawa.jp tsurugi.ishikawa.jp uchinada.ishikawa.jp " +
    "wajima.ishikawa.jp fudai.iwate.jp fujisawa.iwate.jp hanamaki.iwate.jp hiraizumi.iwate.jp hirono.iwate.jp " +
    "ichinohe.iwate.jp ichinoseki.iwate.jp iwaizumi.iwate.jp iwate.iwate.jp joboji.iwate.jp kamaishi.iwate.jp " +
    "kanegasaki.iwate.jp karumai.iwate.jp kawai.iwate.jp kitakami.iwate.jp kuji.iwate.jp kunohe.iwate.jp " +
    "kuzumaki.iwate.jp miyako.iwate.jp mizusawa.iwate.jp morioka.iwate.jp ninohe.iwate.jp noda.iwate.jp " +
    "ofunato.iwate.jp oshu.iwate.jp otsuchi.iwate.jp rikuzentakata.iwate.jp shiwa.iwate.jp shizukuishi.iwate.jp " +
    "sumita.iwate.jp tanohata.iwate.jp tono.iwate.jp yahaba.iwate.jp yamada.iwate.jp ayagawa.kagawa.jp " +
    "higashikagawa.kagawa.jp kanonji.kagawa.jp kotohira.kagawa.jp manno.kagawa.jp marugame.kagawa.jp " +
    "mitoyo.kagawa.jp naoshima.kagawa.jp sanuki.kagawa.jp tadotsu.kagawa.jp takamatsu.kagawa.jp " +
    "tonosho.kagawa.jp uchinomi.kagawa.jp utazu.kagawa.jp zentsuji.kagawa.jp akune.kagoshima.jp " +
    "amami.kagoshima.jp hioki.kagoshima.jp isa.kagoshima.jp isen.kagoshima.jp izumi.kagoshima.jp " +
    "kagoshima.kagoshima.jp kanoya.kagoshima.jp kawanabe.kagoshima.jp kinko.kagoshima.jp kouyama.kagoshima.jp " +
    "makurazaki.kagoshima.jp matsumoto.kagoshima.jp minamitane.kagoshima.jp nakatane.kagoshima.jp " +
    "nishinoomote.kagoshima.jp satsumasendai.kagoshima.jp soo.kagoshima.jp tarumizu.kagoshima.jp " +
    "yusui.kagoshima.jp aikawa.kanagawa.jp atsugi.kanagawa.jp ayase.kanagawa.jp chigasaki.kanagawa.jp " +
    "ebina.kanagawa.jp fujisawa.kanagawa.jp hadano.kanagawa.jp hakone.kanagawa.jp hiratsuka.kanagawa.jp " +
    "isehara.kanagawa.jp kaisei.kanagawa.jp kamakura.kanagawa.jp kiyokawa.kanagawa.jp matsuda.kanagawa.jp " +
    "minamiashigara.kanagawa.jp miura.kanagawa.jp nakai.kanagawa.jp ninomiya.kanagawa.jp odawara.kanagawa.jp " +
    "oi.kanagawa.jp oiso.kanagawa.jp sagamihara.kanagawa.jp samukawa.kanagawa.jp tsukui.kanagawa.jp " +
    "yamakita.kanagawa.jp yamato.kanagawa.jp yokosuka.kanagawa.jp yugawara.kanagawa.jp zama.kanagawa.jp " +
    "zushi.kanagawa.jp aki.kochi.jp geisei.kochi.jp hidaka.kochi.jp higashitsuno.kochi.jp ino.kochi.jp " +
    "kagami.kochi.jp kami.kochi.jp kitagawa.kochi.jp kochi.kochi.jp mihara.kochi.jp motoyama.kochi.jp " +
    "muroto.kochi.jp nahari.kochi.jp nakamura.kochi.jp nankoku.kochi.jp nishitosa.kochi.jp niyodogawa.kochi.jp " +
    "ochi.kochi.jp okawa.kochi.jp otoyo.kochi.jp otsuki.kochi.jp sakawa.kochi.jp sukumo.kochi.jp susaki.kochi.jp " +
    "tosa.kochi.jp tosashimizu.kochi.jp toyo.kochi.jp tsuno.kochi.jp umaji.kochi.jp yasuda.kochi.jp " +
    "yusuhara.kochi.jp amakusa.kumamoto.jp arao.kumamoto.jp aso.kumamoto.jp choyo.kumamoto.jp " +
    "gyokuto.kumamoto.jp kamiamakusa.kumamoto.jp kikuchi.kumamoto.jp kumamoto.kumamoto.jp mashiki.kumamoto.jp " +
    "mifune.kumamoto.jp minamata.kumamoto.jp minamioguni.kumamoto.jp nagasu.kumamoto.jp nishihara.kumamoto.jp " +
    "oguni.kumamoto.jp ozu.kumamoto.jp sumoto.kumamoto.jp takamori.kumamoto.jp uki.kumamoto.jp uto.kumamoto.jp " +
    "yamaga.kumamoto.jp yamato.kumamoto.jp yatsushiro.kumamoto.jp ayabe.kyoto.jp fukuchiyama.kyoto.jp " +
    "higashiyama.kyoto.jp ide.kyoto.jp ine.kyoto.jp joyo.kyoto.jp kameoka.kyoto.jp kamo.kyoto.jp kita.kyoto.jp " +
    "kizu.kyoto.jp kumiyama.kyoto.jp kyotamba.kyoto.jp kyotanabe.kyoto.jp kyotango.kyoto.jp maizuru.kyoto.jp " +
    "minami.kyoto.jp minamiyamashiro.kyoto.jp miyazu.kyoto.jp muko.kyoto.jp nagaokakyo.kyoto.jp nakagyo.kyoto.jp " +
    "nantan.kyoto.jp oyamazaki.kyoto.jp sakyo.kyoto.jp seika.kyoto.jp tanabe.kyoto.jp uji.kyoto.jp " +
    "ujitawara.kyoto.jp wazuka.kyoto.jp yamashina.kyoto.jp yawata.kyoto.jp asahi.mie.jp inabe.mie.jp ise.mie.jp " +
    "kameyama.mie.jp kawagoe.mie.jp kiho.mie.jp kisosaki.mie.jp kiwa.mie.jp komono.mie.jp kumano.mie.jp " +
    "kuwana.mie.jp matsusaka.mie.jp meiwa.mie.jp mihama.mie.jp minamiise.mie.jp misugi.mie.jp miyama.mie.jp " +
    "nabari.mie.jp shima.mie.jp suzuka.mie.jp tado.mie.jp taiki.mie.jp taki.mie.jp tamaki.mie.jp toba.mie.jp " +
    "tsu.mie.jp udono.mie.jp ureshino.mie.jp watarai.mie.jp yokkaichi.mie.jp furukawa.miyagi.jp " +
    "higashimatsushima.miyagi.jp ishinomaki.miyagi.jp iwanuma.miyagi.jp kakuda.miyagi.jp kami.miyagi.jp " +
    "kawasaki.miyagi.jp marumori.miyagi.jp matsushima.miyagi.jp minamisanriku.miyagi.jp misato.miyagi.jp " +
    "murata.miyagi.jp natori.miyagi.jp ogawara.miyagi.jp ohira.miyagi.jp onagawa.miyagi.jp osaki.miyagi.jp " +
    "rifu.miyagi.jp semine.miyagi.jp shibata.miyagi.jp shichikashuku.miyagi.jp shikama.miyagi.jp " +
    "shiogama.miyagi.jp shiroishi.miyagi.jp tagajo.miyagi.jp taiwa.miyagi.jp tome.miyagi.jp tomiya.miyagi.jp " +
    "wakuya.miyagi.jp watari.miyagi.jp yamamoto.miyagi.jp zao.miyagi.jp aya.miyazaki.jp ebino.miyazaki.jp " +
    "gokase.miyazaki.jp hyuga.miyazaki.jp kadogawa.miyazaki.jp kawaminami.miyazaki.jp kijo.miyazaki.jp " +
    "kitagawa.miyazaki.jp kitakata.miyazaki.jp kitaura.miyazaki.jp kobayashi.miyazaki.jp kunitomi.miyazaki.jp " +
    "kushima.miyazaki.jp mimata.miyazaki.jp miyakonojo.miyazaki.jp miyazaki.miyazaki.jp morotsuka.miyazaki.jp " +
    "nichinan.miyazaki.jp nishimera.miyazaki.jp nobeoka.miyazaki.jp saito.miyazaki.jp shiiba.miyazaki.jp " +
    "shintomi.miyazaki.jp takaharu.miyazaki.jp takanabe.miyazaki.jp takazaki.miyazaki.jp tsuno.miyazaki.jp " +
    "achi.nagano.jp agematsu.nagano.jp anan.nagano.jp aoki.nagano.jp asahi.nagano.jp azumino.nagano.jp " +
    "chikuhoku.nagano.jp chikuma.nagano.jp chino.nagano.jp fujimi.nagano.jp hakuba.nagano.jp hara.nagano.jp " +
    "hiraya.nagano.jp iida.nagano.jp iijima.nagano.jp iiyama.nagano.jp iizuna.nagano.jp ikeda.nagano.jp " +
    "ikusaka.nagano.jp ina.nagano.jp karuizawa.nagano.jp kawakami.nagano.jp kiso.nagano.jp " +
    "kisofukushima.nagano.jp kitaaiki.nagano.jp komagane.nagano.jp komoro.nagano.jp matsukawa.nagano.jp " +
    "matsumoto.nagano.jp miasa.nagano.jp minamiaiki.nagano.jp minamimaki.nagano.jp minamiminowa.nagano.jp " +
    "minowa.nagano.jp miyada.nagano.jp miyota.nagano.jp mochizuki.nagano.jp nagano.nagano.jp nagawa.nagano.jp " +
    "nagiso.nagano.jp nakagawa.nagano.jp nakano.nagano.jp nozawaonsen.nagano.jp obuse.nagano.jp ogawa.nagano.jp " +
    "okaya.nagano.jp omachi.nagano.jp omi.nagano.jp ookuwa.nagano.jp ooshika.nagano.jp otaki.nagano.jp " +
    "otari.nagano.jp sakae.nagano.jp sakaki.nagano.jp saku.nagano.jp sakuho.nagano.jp shimosuwa.nagano.jp " +
    "shinanomachi.nagano.jp shiojiri.nagano.jp suwa.nagano.jp suzaka.nagano.jp takagi.nagano.jp " +
    "takamori.nagano.jp takayama.nagano.jp tateshina.nagano.jp tatsuno.nagano.jp togakushi.nagano.jp " +
    "togura.nagano.jp tomi.nagano.jp ueda.nagano.jp wada.nagano.jp yamagata.nagano.jp yamanouchi.nagano.jp " +
    "yasaka.nagano.jp yasuoka.nagano.jp chijiwa.nagasaki.jp futsu.nagasaki.jp goto.nagasaki.jp " +
    "hasami.nagasaki.jp hirado.nagasaki.jp iki.nagasaki.jp isahaya.nagasaki.jp kawatana.nagasaki.jp " +
    "kuchinotsu.nagasaki.jp matsuura.nagasaki.jp nagasaki.nagasaki.jp obama.nagasaki.jp omura.nagasaki.jp " +
    "oseto.nagasaki.jp saikai.nagasaki.jp sasebo.nagasaki.jp seihi.nagasaki.jp shimabara.nagasaki.jp " +
    "shinkamigoto.nagasaki.jp togitsu.nagasaki.jp tsushima.nagasaki.jp unzen.nagasaki.jp ando.nara.jp " +
    "gose.nara.jp heguri.nara.jp higashiyoshino.nara.jp ikaruga.nara.jp ikoma.nara.jp kamikitayama.nara.jp " +
    "kanmaki.nara.jp kashiba.nara.jp kashihara.nara.jp katsuragi.nara.jp kawai.nara.jp kawakami.nara.jp " +
    "kawanishi.nara.jp koryo.nara.jp kurotaki.nara.jp mitsue.nara.jp miyake.nara.jp nara.nara.jp " +
    "nosegawa.nara.jp oji.nara.jp ouda.nara.jp oyodo.nara.jp sakurai.nara.jp sango.nara.jp shimoichi.nara.jp " +
    "shimokitayama.nara.jp shinjo.nara.jp soni.nara.jp takatori.nara.jp tawaramoto.nara.jp tenkawa.nara.jp " +
    "tenri.nara.jp uda.nara.jp yamatokoriyama.nara.jp yamatotakada.nara.jp yamazoe.nara.jp yoshino.nara.jp " +
    "aga.niigata.jp agano.niigata.jp gosen.niigata.jp itoigawa.niigata.jp izumozaki.niigata.jp joetsu.niigata.jp " +
    "kamo.niigata.jp kariwa.niigata.jp kashiwazaki.niigata.jp minamiuonuma.niigata.jp mitsuke.niigata.jp " +
    "muika.niigata.jp murakami.niigata.jp myoko.niigata.jp nagaoka.niigata.jp niigata.niigata.jp " +
    "ojiya.niigata.jp omi.niigata.jp sado.niigata.jp sanjo.niigata.jp seiro.niigata.jp seirou.niigata.jp " +
    "sekikawa.niigata.jp shibata.niigata.jp tagami.niigata.jp tainai.niigata.jp tochio.niigata.jp " +
    "tokamachi.niigata.jp tsubame.niigata.jp tsunan.niigata.jp uonuma.niigata.jp yahiko.niigata.jp " +
    "yoita.niigata.jp yuzawa.niigata.jp beppu.oita.jp bungoono.oita.jp bungotakada.oita.jp hasama.oita.jp " +
    "hiji.oita.jp himeshima.oita.jp hita.oita.jp kamitsue.oita.jp kokonoe.oita.jp kuju.oita.jp kunisaki.oita.jp " +
    "kusu.oita.jp oita.oita.jp saiki.oita.jp taketa.oita.jp tsukumi.oita.jp usa.oita.jp usuki.oita.jp " +
    "yufu.oita.jp akaiwa.okayama.jp asakuchi.okayama.jp bizen.okayama.jp hayashima.okayama.jp ibara.okayama.jp " +
    "kagamino.okayama.jp kasaoka.okayama.jp kibichuo.okayama.jp kumenan.okayama.jp kurashiki.okayama.jp " +
    "maniwa.okayama.jp misaki.okayama.jp nagi.okayama.jp niimi.okayama.jp nishiawakura.okayama.jp " +
    "okayama.okayama.jp satosho.okayama.jp setouchi.okayama.jp shinjo.okayama.jp shoo.okayama.jp soja.okayama.jp " +
    "takahashi.okayama.jp tamano.okayama.jp tsuyama.okayama.jp wake.okayama.jp yakage.okayama.jp " +
    "aguni.okinawa.jp ginowan.okinawa.jp ginoza.okinawa.jp gushikami.okinawa.jp haebaru.okinawa.jp " +
    "higashi.okinawa.jp hirara.okinawa.jp iheya.okinawa.jp ishigaki.okinawa.jp ishikawa.okinawa.jp " +
    "itoman.okinawa.jp izena.okinawa.jp kadena.okinawa.jp kin.okinawa.jp kitadaito.okinawa.jp " +
    "kitanakagusuku.okinawa.jp kumejima.okinawa.jp kunigami.okinawa.jp minamidaito.okinawa.jp motobu.okinawa.jp " +
    "nago.okinawa.jp naha.okinawa.jp nakagusuku.okinawa.jp nakijin.okinawa.jp nanjo.okinawa.jp " +
    "nishihara.okinawa.jp ogimi.okinawa.jp okinawa.okinawa.jp onna.okinawa.jp shimoji.okinawa.jp " +
    "taketomi.okinawa.jp tarama.okinawa.jp tokashiki.okinawa.jp tomigusuku.okinawa.jp tonaki.okinawa.jp " +
    "urasoe.okinawa.jp uruma.okinawa.jp yaese.okinawa.jp yomitan.okinawa.jp yonabaru.okinawa.jp " +
    "yonaguni.okinawa.jp zamami.okinawa.jp abeno.osaka.jp chihayaakasaka.osaka.jp chuo.osaka.jp daito.osaka.jp " +
    "fujiidera.osaka.jp habikino.osaka.jp hannan.osaka.jp higashiosaka.osaka.jp higashisumiyoshi.osaka.jp " +
    "higashiyodogawa.osaka.jp hirakata.osaka.jp ibaraki.osaka.jp ikeda.osaka.jp izumi.osaka.jp " +
    "izumiotsu.osaka.jp izumisano.osaka.jp kadoma.osaka.jp kaizuka.osaka.jp kanan.osaka.jp kashiwara.osaka.jp " +
    "katano.osaka.jp kawachinagano.osaka.jp kishiwada.osaka.jp kita.osaka.jp kumatori.osaka.jp " +
    "matsubara.osaka.jp minato.osaka.jp minoh.osaka.jp misaki.osaka.jp moriguchi.osaka.jp neyagawa.osaka.jp " +
    "nishi.osaka.jp nose.osaka.jp osakasayama.osaka.jp sakai.osaka.jp sayama.osaka.jp sennan.osaka.jp " +
    "settsu.osaka.jp shijonawate.osaka.jp shimamoto.osaka.jp suita.osaka.jp tadaoka.osaka.jp taishi.osaka.jp " +
    "tajiri.osaka.jp takaishi.osaka.jp takatsuki.osaka.jp tondabayashi.osaka.jp toyonaka.osaka.jp " +
    "toyono.osaka.jp yao.osaka.jp ariake.saga.jp arita.saga.jp fukudomi.saga.jp genkai.saga.jp hamatama.saga.jp " +
    "hizen.saga.jp imari.saga.jp kamimine.saga.jp kanzaki.saga.jp karatsu.saga.jp kashima.saga.jp " +
    "kitagata.saga.jp kitahata.saga.jp kiyama.saga.jp kouhoku.saga.jp kyuragi.saga.jp nishiarita.saga.jp " +
    "ogi.saga.jp omachi.saga.jp ouchi.saga.jp saga.saga.jp shiroishi.saga.jp taku.saga.jp tara.saga.jp " +
    "tosu.saga.jp yoshinogari.saga.jp arakawa.saitama.jp asaka.saitama.jp chichibu.saitama.jp fujimi.saitama.jp " +
    "fujimino.saitama.jp fukaya.saitama.jp hanno.saitama.jp hanyu.saitama.jp hasuda.saitama.jp " +
    "hatogaya.saitama.jp hatoyama.saitama.jp hidaka.saitama.jp higashichichibu.saitama.jp " +
    "higashimatsuyama.saitama.jp honjo.saitama.jp ina.saitama.jp iruma.saitama.jp iwatsuki.saitama.jp " +
    "kamiizumi.saitama.jp kamikawa.saitama.jp kamisato.saitama.jp kasukabe.saitama.jp kawagoe.saitama.jp " +
    "kawaguchi.saitama.jp kawajima.saitama.jp kazo.saitama.jp kitamoto.saitama.jp koshigaya.saitama.jp " +
    "kounosu.saitama.jp kuki.saitama.jp kumagaya.saitama.jp matsubushi.saitama.jp minano.saitama.jp " +
    "misato.saitama.jp miyashiro.saitama.jp miyoshi.saitama.jp moroyama.saitama.jp nagatoro.saitama.jp " +
    "namegawa.saitama.jp niiza.saitama.jp ogano.saitama.jp ogawa.saitama.jp ogose.saitama.jp okegawa.saitama.jp " +
    "omiya.saitama.jp otaki.saitama.jp ranzan.saitama.jp ryokami.saitama.jp saitama.saitama.jp sakado.saitama.jp " +
    "satte.saitama.jp sayama.saitama.jp shiki.saitama.jp shiraoka.saitama.jp soka.saitama.jp sugito.saitama.jp " +
    "toda.saitama.jp tokigawa.saitama.jp tokorozawa.saitama.jp tsurugashima.saitama.jp urawa.saitama.jp " +
    "warabi.saitama.jp yashio.saitama.jp yokoze.saitama.jp yono.saitama.jp yorii.saitama.jp yoshida.saitama.jp " +
    "yoshikawa.saitama.jp yoshimi.saitama.jp aisho.shiga.jp gamo.shiga.jp higashiomi.shiga.jp hikone.shiga.jp " +
    "koka.shiga.jp konan.shiga.jp kosei.shiga.jp koto.shiga.jp kusatsu.shiga.jp maibara.shiga.jp " +
    "moriyama.shiga.jp nagahama.shiga.jp nishiazai.shiga.jp notogawa.shiga.jp omihachiman.shiga.jp otsu.shiga.jp " +
    "ritto.shiga.jp ryuoh.shiga.jp takashima.shiga.jp takatsuki.shiga.jp torahime.shiga.jp toyosato.shiga.jp " +
    "yasu.shiga.jp akagi.shimane.jp ama.shimane.jp gotsu.shimane.jp hamada.shimane.jp higashiizumo.shimane.jp " +
    "hikawa.shimane.jp hikimi.shimane.jp izumo.shimane.jp kakinoki.shimane.jp masuda.shimane.jp " +
    "matsue.shimane.jp misato.shimane.jp nishinoshima.shimane.jp ohda.shimane.jp okinoshima.shimane.jp " +
    "okuizumo.shimane.jp shimane.shimane.jp tamayu.shimane.jp tsuwano.shimane.jp unnan.shimane.jp " +
    "yakumo.shimane.jp yasugi.shimane.jp yatsuka.shimane.jp arai.shizuoka.jp atami.shizuoka.jp fuji.shizuoka.jp " +
    "fujieda.shizuoka.jp fujikawa.shizuoka.jp fujinomiya.shizuoka.jp fukuroi.shizuoka.jp gotemba.shizuoka.jp " +
    "haibara.shizuoka.jp hamamatsu.shizuoka.jp higashiizu.shizuoka.jp ito.shizuoka.jp iwata.shizuoka.jp " +
    "izu.shizuoka.jp izunokuni.shizuoka.jp kakegawa.shizuoka.jp kannami.shizuoka.jp kawanehon.shizuoka.jp " +
    "kawazu.shizuoka.jp kikugawa.shizuoka.jp kosai.shizuoka.jp makinohara.shizuoka.jp matsuzaki.shizuoka.jp " +
    "minamiizu.shizuoka.jp mishima.shizuoka.jp morimachi.shizuoka.jp nishiizu.shizuoka.jp numazu.shizuoka.jp " +
    "omaezaki.shizuoka.jp shimada.shizuoka.jp shimizu.shizuoka.jp shimoda.shizuoka.jp shizuoka.shizuoka.jp " +
    "susono.shizuoka.jp yaizu.shizuoka.jp yoshida.shizuoka.jp ashikaga.tochigi.jp bato.tochigi.jp " +
    "haga.tochigi.jp ichikai.tochigi.jp iwafune.tochigi.jp kaminokawa.tochigi.jp kanuma.tochigi.jp " +
    "karasuyama.tochigi.jp kuroiso.tochigi.jp mashiko.tochigi.jp mibu.tochigi.jp moka.tochigi.jp " +
    "motegi.tochigi.jp nasu.tochigi.jp nasushiobara.tochigi.jp nikko.tochigi.jp nishikata.tochigi.jp " +
    "nogi.tochigi.jp ohira.tochigi.jp ohtawara.tochigi.jp oyama.tochigi.jp sakura.tochigi.jp sano.tochigi.jp " +
    "shimotsuke.tochigi.jp shioya.tochigi.jp takanezawa.tochigi.jp tochigi.tochigi.jp tsuga.tochigi.jp " +
    "ujiie.tochigi.jp utsunomiya.tochigi.jp yaita.tochigi.jp aizumi.tokushima.jp anan.tokushima.jp " +
    "ichiba.tokushima.jp itano.tokushima.jp kainan.tokushima.jp komatsushima.tokushima.jp " +
    "matsushige.tokushima.jp mima.tokushima.jp minami.tokushima.jp miyoshi.tokushima.jp mugi.tokushima.jp " +
    "nakagawa.tokushima.jp naruto.tokushima.jp sanagochi.tokushima.jp shishikui.tokushima.jp " +
    "tokushima.tokushima.jp wajiki.tokushima.jp adachi.tokyo.jp akiruno.tokyo.jp akishima.tokyo.jp " +
    "aogashima.tokyo.jp arakawa.tokyo.jp bunkyo.tokyo.jp chiyoda.tokyo.jp chofu.tokyo.jp chuo.tokyo.jp " +
    "edogawa.tokyo.jp fuchu.tokyo.jp fussa.tokyo.jp hachijo.tokyo.jp hachioji.tokyo.jp hamura.tokyo.jp " +
    "higashikurume.tokyo.jp higashimurayama.tokyo.jp higashiyamato.tokyo.jp hino.tokyo.jp hinode.tokyo.jp " +
    "hinohara.tokyo.jp inagi.tokyo.jp itabashi.tokyo.jp katsushika.tokyo.jp kita.tokyo.jp kiyose.tokyo.jp " +
    "kodaira.tokyo.jp koganei.tokyo.jp kokubunji.tokyo.jp komae.tokyo.jp koto.tokyo.jp kouzushima.tokyo.jp " +
    "kunitachi.tokyo.jp machida.tokyo.jp meguro.tokyo.jp minato.tokyo.jp mitaka.tokyo.jp mizuho.tokyo.jp " +
    "musashimurayama.tokyo.jp musashino.tokyo.jp nakano.tokyo.jp nerima.tokyo.jp ogasawara.tokyo.jp " +
    "okutama.tokyo.jp ome.tokyo.jp oshima.tokyo.jp ota.tokyo.jp setagaya.tokyo.jp shibuya.tokyo.jp " +
    "shinagawa.tokyo.jp shinjuku.tokyo.jp suginami.tokyo.jp sumida.tokyo.jp tachikawa.tokyo.jp taito.tokyo.jp " +
    "tama.tokyo.jp toshima.tokyo.jp chizu.tottori.jp hino.tottori.jp kawahara.tottori.jp koge.tottori.jp " +
    "kotoura.tottori.jp misasa.tottori.jp nanbu.tottori.jp nichinan.tottori.jp sakaiminato.tottori.jp " +
    "tottori.tottori.jp wakasa.tottori.jp yazu.tottori.jp yonago.tottori.jp asahi.toyama.jp fuchu.toyama.jp " +
    "fukumitsu.toyama.jp funahashi.toyama.jp himi.toyama.jp imizu.toyama.jp inami.toyama.jp johana.toyama.jp " +
    "kamiichi.toyama.jp kurobe.toyama.jp nakaniikawa.toyama.jp namerikawa.toyama.jp nanto.toyama.jp " +
    "nyuzen.toyama.jp oyabe.toyama.jp taira.toyama.jp takaoka.toyama.jp tateyama.toyama.jp toga.toyama.jp " +
    "tonami.toyama.jp toyama.toyama.jp unazuki.toyama.jp uozu.toyama.jp yamada.toyama.jp arida.wakayama.jp " +
    "aridagawa.wakayama.jp gobo.wakayama.jp hashimoto.wakayama.jp hidaka.wakayama.jp hirogawa.wakayama.jp " +
    "inami.wakayama.jp iwade.wakayama.jp kainan.wakayama.jp kamitonda.wakayama.jp katsuragi.wakayama.jp " +
    "kimino.wakayama.jp kinokawa.wakayama.jp kitayama.wakayama.jp koya.wakayama.jp koza.wakayama.jp " +
    "kozagawa.wakayama.jp kudoyama.wakayama.jp kushimoto.wakayama.jp mihama.wakayama.jp misato.wakayama.jp " +
    "nachikatsuura.wakayama.jp shingu.wakayama.jp shirahama.wakayama.jp taiji.wakayama.jp tanabe.wakayama.jp " +
    "wakayama.wakayama.jp yuasa.wakayama.jp yura.wakayama.jp asahi.yamagata.jp funagata.yamagata.jp " +
    "higashine.yamagata.jp iide.yamagata.jp kahoku.yamagata.jp kaminoyama.yamagata.jp kaneyama.yamagata.jp " +
    "kawanishi.yamagata.jp mamurogawa.yamagata.jp mikawa.yamagata.jp murayama.yamagata.jp nagai.yamagata.jp " +
    "nakayama.yamagata.jp nanyo.yamagata.jp nishikawa.yamagata.jp obanazawa.yamagata.jp oe.yamagata.jp " +
    "oguni.yamagata.jp ohkura.yamagata.jp oishida.yamagata.jp sagae.yamagata.jp sakata.yamagata.jp " +
    "sakegawa.yamagata.jp shinjo.yamagata.jp shirataka.yamagata.jp shonai.yamagata.jp takahata.yamagata.jp " +
    "tendo.yamagata.jp tozawa.yamagata.jp tsuruoka.yamagata.jp yamagata.yamagata.jp yamanobe.yamagata.jp " +
    "yonezawa.yamagata.jp yuza.yamagata.jp abu.yamaguchi.jp hagi.yamaguchi.jp hikari.yamaguchi.jp " +
    "hofu.yamaguchi.jp iwakuni.yamaguchi.jp kudamatsu.yamaguchi.jp mitou.yamaguchi.jp nagato.yamaguchi.jp " +
    "oshima.yamaguchi.jp shimonoseki.yamaguchi.jp shunan.yamaguchi.jp tabuse.yamaguchi.jp tokuyama.yamaguchi.jp " +
    "toyota.yamaguchi.jp ube.yamaguchi.jp yuu.yamaguchi.jp chuo.yamanashi.jp doshi.yamanashi.jp " +
    "fuefuki.yamanashi.jp fujikawa.yamanashi.jp fujikawaguchiko.yamanashi.jp fujiyoshida.yamanashi.jp " +
    "hayakawa.yamanashi.jp hokuto.yamanashi.jp ichikawamisato.yamanashi.jp kai.yamanashi.jp kofu.yamanashi.jp " +
    "koshu.yamanashi.jp kosuge.yamanashi.jp minami-alps.yamanashi.jp minobu.yamanashi.jp nakamichi.yamanashi.jp " +
    "nanbu.yamanashi.jp narusawa.yamanashi.jp nirasaki.yamanashi.jp nishikatsura.yamanashi.jp " +
    "oshino.yamanashi.jp otsuki.yamanashi.jp showa.yamanashi.jp tabayama.yamanashi.jp tsuru.yamanashi.jp " +
    "uenohara.yamanashi.jp yamanakako.yamanashi.jp yamanashi.yamanashi.jp ac.ke co.ke go.ke info.ke me.ke " +
    "mobi.ke ne.ke or.ke sc.ke com.kg edu.kg gov.kg mil.kg net.kg org.kg com.kh edu.kh gov.kh net.kh org.kh " +
    "biz.ki com.ki edu.ki gov.ki info.ki net.ki org.ki ass.km com.km edu.km gov.km mil.km nom.km org.km prd.km " +
    "tm.km asso.km coop.km gouv.km medecin.km notaires.km pharmaciens.km presse.km veterinaire.km edu.kn gov.kn " +
    "net.kn org.kn com.kp edu.kp gov.kp org.kp rep.kp tra.kp ac.kr ai.kr co.kr es.kr go.kr hs.kr io.kr it.kr " +
    "kg.kr me.kr mil.kr ms.kr ne.kr or.kr pe.kr re.kr sc.kr busan.kr chungbuk.kr chungnam.kr daegu.kr daejeon.kr " +
    "gangwon.kr gwangju.kr gyeongbuk.kr gyeonggi.kr gyeongnam.kr incheon.kr jeju.kr jeonbuk.kr jeonnam.kr " +
    "seoul.kr ulsan.kr com.kw edu.kw emb.kw gov.kw ind.kw net.kw org.kw com.ky edu.ky net.ky org.ky com.kz " +
    "edu.kz gov.kz mil.kz net.kz org.kz com.la edu.la gov.la info.la int.la net.la org.la per.la com.lb edu.lb " +
    "gov.lb net.lb org.lb co.lc com.lc edu.lc gov.lc net.lc org.lc ac.lk assn.lk com.lk edu.lk gov.lk grp.lk " +
    "hotel.lk int.lk ltd.lk net.lk ngo.lk org.lk sch.lk soc.lk web.lk com.lr edu.lr gov.lr net.lr org.lr ac.ls " +
    "biz.ls co.ls edu.ls gov.ls info.ls net.ls org.ls sc.ls gov.lt asn.lv com.lv conf.lv edu.lv gov.lv id.lv " +
    "mil.lv net.lv org.lv com.ly edu.ly gov.ly id.ly med.ly net.ly org.ly plc.ly sch.ly ac.ma co.ma gov.ma " +
    "net.ma org.ma press.ma asso.mc tm.mc ac.me co.me edu.me gov.me its.me net.me org.me priv.me co.mg com.mg " +
    "edu.mg gov.mg mil.mg nom.mg org.mg prd.mg com.mk edu.mk gov.mk inf.mk name.mk net.mk org.mk ac.ml art.ml " +
    "asso.ml com.ml edu.ml gouv.ml gov.ml info.ml inst.ml net.ml org.ml pr.ml presse.ml *.mm edu.mn gov.mn " +
    "org.mn com.mo edu.mo gov.mo net.mo org.mo gov.mr com.ms edu.ms gov.ms net.ms org.ms com.mt edu.mt net.mt " +
    "org.mt ac.mu co.mu com.mu gov.mu net.mu or.mu org.mu aero.mv biz.mv com.mv coop.mv edu.mv gov.mv info.mv " +
    "int.mv mil.mv museum.mv name.mv net.mv org.mv pro.mv ac.mw biz.mw co.mw com.mw coop.mw edu.mw gov.mw int.mw " +
    "net.mw org.mw com.mx edu.mx gob.mx net.mx org.mx biz.my com.my edu.my gov.my mil.my name.my net.my org.my " +
    "ac.mz adv.mz co.mz edu.mz gov.mz mil.mz net.mz org.mz alt.na co.na com.na gov.na net.na org.na asso.nc " +
    "nom.nc arts.nf com.nf firm.nf info.nf net.nf other.nf per.nf rec.nf store.nf web.nf com.ng edu.ng gov.ng " +
    "i.ng mil.ng mobi.ng name.ng net.ng org.ng sch.ng ac.ni biz.ni co.ni com.ni edu.ni gob.ni in.ni info.ni " +
    "int.ni mil.ni net.ni nom.ni org.ni web.ni fhs.no folkebibl.no fylkesbibl.no gielda.no herad.no idrett.no " +
    "kommune.no museum.no priv.no suohkan.no tjielte.no uenorge.no vgs.no dep.no mil.no stat.no aa.no ah.no " +
    "bu.no fm.no hl.no hm.no jan-mayen.no mr.no nl.no nt.no of.no ol.no oslo.no rl.no sf.no st.no svalbard.no " +
    "tm.no tr.no va.no vf.no gs.aa.no gs.ah.no gs.bu.no gs.fm.no gs.hl.no gs.hm.no gs.jan-mayen.no gs.mr.no " +
    "gs.nl.no gs.nt.no gs.of.no gs.ol.no gs.oslo.no gs.rl.no gs.sf.no gs.st.no gs.svalbard.no gs.tm.no gs.tr.no " +
    "gs.va.no gs.vf.no akrehamn.no åkrehamn.no algard.no ålgård.no arna.no bronnoysund.no brønnøysund.no " +
    "brumunddal.no bryne.no drobak.no drøbak.no egersund.no fetsund.no floro.no florø.no fredrikstad.no " +
    "hokksund.no honefoss.no hønefoss.no jessheim.no jorpeland.no jørpeland.no kirkenes.no kopervik.no " +
    "krokstadelva.no langevag.no langevåg.no leirvik.no mjondalen.no mjøndalen.no mo-i-rana.no mosjoen.no " +
    "mosjøen.no nesoddtangen.no orkanger.no osoyro.no osøyro.no raholt.no råholt.no sandnessjoen.no " +
    "sandnessjøen.no skedsmokorset.no slattum.no spjelkavik.no stathelle.no stavern.no stjordalshalsen.no " +
    "stjørdalshalsen.no tananger.no tranby.no vossevangen.no aarborte.no aejrie.no afjord.no åfjord.no " +
    "agdenes.no nes.akershus.no aknoluokta.no ákŋoluokta.no al.no ål.no alaheadju.no álaheadju.no alesund.no " +
    "ålesund.no alstahaug.no alta.no áltá.no alvdal.no amli.no åmli.no amot.no åmot.no andasuolo.no " +
    "andebu.no andoy.no andøy.no ardal.no årdal.no aremark.no arendal.no ås.no aseral.no åseral.no asker.no " +
    "askim.no askoy.no askøy.no askvoll.no asnes.no åsnes.no audnedal.no aukra.no aure.no aurland.no " +
    "aurskog-holand.no aurskog-høland.no austevoll.no austrheim.no averoy.no averøy.no badaddja.no " +
    "bådåddjå.no bærum.no bahcavuotna.no báhcavuotna.no bahccavuotna.no báhccavuotna.no baidar.no " +
    "báidár.no bajddar.no bájddar.no balat.no bálát.no balestrand.no ballangen.no balsfjord.no bamble.no " +
    "bardu.no barum.no batsfjord.no båtsfjord.no bearalvahki.no bearalváhki.no beardu.no beiarn.no berg.no " +
    "bergen.no berlevag.no berlevåg.no bievat.no bievát.no bindal.no birkenes.no bjerkreim.no bjugn.no bodo.no " +
    "bodø.no bokn.no bomlo.no bømlo.no bremanger.no bronnoy.no brønnøy.no budejju.no nes.buskerud.no " +
    "bygland.no bykle.no cahcesuolo.no čáhcesuolo.no davvenjarga.no davvenjárga.no davvesiida.no deatnu.no " +
    "dielddanuorri.no divtasvuodna.no divttasvuotna.no donna.no dønna.no dovre.no drammen.no drangedal.no " +
    "dyroy.no dyrøy.no eid.no eidfjord.no eidsberg.no eidskog.no eidsvoll.no eigersund.no elverum.no enebakk.no " +
    "engerdal.no etne.no etnedal.no evenassi.no evenášši.no evenes.no evje-og-hornnes.no farsund.no fauske.no " +
    "fedje.no fet.no finnoy.no finnøy.no fitjar.no fjaler.no fjell.no fla.no flå.no flakstad.no flatanger.no " +
    "flekkefjord.no flesberg.no flora.no folldal.no forde.no førde.no forsand.no fosnes.no fræna.no frana.no " +
    "frogn.no froland.no frosta.no froya.no frøya.no fuoisku.no fuossko.no fusa.no fyresdal.no gaivuotna.no " +
    "gáivuotna.no galsa.no gálsá.no gamvik.no gangaviika.no gáŋgaviika.no gaular.no gausdal.no " +
    "giehtavuoatna.no gildeskal.no gildeskål.no giske.no gjemnes.no gjerdrum.no gjerstad.no gjesdal.no " +
    "gjovik.no gjøvik.no gloppen.no gol.no gran.no grane.no granvin.no gratangen.no grimstad.no grong.no " +
    "grue.no gulen.no guovdageaidnu.no ha.no hå.no habmer.no hábmer.no hadsel.no hægebostad.no hagebostad.no " +
    "halden.no halsa.no hamar.no hamaroy.no hamarøy.no hammarfeasta.no hámmárfeasta.no hammerfest.no " +
    "hapmir.no hápmir.no haram.no hareid.no harstad.no hasvik.no hattfjelldal.no haugesund.no os.hedmark.no " +
    "valer.hedmark.no våler.hedmark.no hemne.no hemnes.no hemsedal.no hitra.no hjartdal.no hjelmeland.no " +
    "hobol.no hobøl.no hof.no hol.no hole.no holmestrand.no holtalen.no holtålen.no os.hordaland.no " +
    "hornindal.no horten.no hoyanger.no høyanger.no hoylandet.no høylandet.no hurdal.no hurum.no hvaler.no " +
    "hyllestad.no ibestad.no inderoy.no inderøy.no iveland.no ivgu.no jevnaker.no jolster.no jølster.no " +
    "jondal.no kafjord.no kåfjord.no karasjohka.no kárášjohka.no karasjok.no karlsoy.no karlsøy.no " +
    "karmoy.no karmøy.no kautokeino.no klabu.no klæbu.no klepp.no kongsberg.no kongsvinger.no kraanghke.no " +
    "kråanghke.no kragero.no kragerø.no kristiansand.no kristiansund.no krodsherad.no krødsherad.no " +
    "kvæfjord.no kvænangen.no kvafjord.no kvalsund.no kvam.no kvanangen.no kvinesdal.no kvinnherad.no " +
    "kviteseid.no kvitsoy.no kvitsøy.no laakesvuemie.no lærdal.no lahppi.no láhppi.no lardal.no larvik.no " +
    "lavagis.no lavangen.no leangaviika.no leaŋgaviika.no lebesby.no leikanger.no leirfjord.no leka.no " +
    "leksvik.no lenvik.no lerdal.no lesja.no levanger.no lier.no lierne.no lillehammer.no lillesand.no lindas.no " +
    "lindås.no lindesnes.no loabat.no loabát.no lodingen.no lødingen.no lom.no loppa.no lorenskog.no " +
    "lørenskog.no loten.no løten.no lund.no lunner.no luroy.no lurøy.no luster.no lyngdal.no lyngen.no " +
    "malatvuopmi.no málatvuopmi.no malselv.no målselv.no malvik.no mandal.no marker.no marnardal.no " +
    "masfjorden.no masoy.no måsøy.no matta-varjjat.no mátta-várjjat.no meland.no meldal.no melhus.no " +
    "meloy.no meløy.no meraker.no meråker.no midsund.no midtre-gauldal.no moareke.no moåreke.no modalen.no " +
    "modum.no molde.no heroy.more-og-romsdal.no sande.more-og-romsdal.no herøy.møre-og-romsdal.no " +
    "sande.møre-og-romsdal.no moskenes.no moss.no muosat.no muosát.no naamesjevuemie.no nååmesjevuemie.no " +
    "nærøy.no namdalseid.no namsos.no namsskogan.no nannestad.no naroy.no narviika.no narvik.no naustdal.no " +
    "navuotna.no návuotna.no nedre-eiker.no nesna.no nesodden.no nesseby.no nesset.no nissedal.no nittedal.no " +
    "nord-aurdal.no nord-fron.no nord-odal.no norddal.no nordkapp.no bo.nordland.no bø.nordland.no " +
    "heroy.nordland.no herøy.nordland.no nordre-land.no nordreisa.no nore-og-uvdal.no notodden.no notteroy.no " +
    "nøtterøy.no odda.no oksnes.no øksnes.no omasvuotna.no oppdal.no oppegard.no oppegård.no orkdal.no " +
    "orland.no ørland.no orskog.no ørskog.no orsta.no ørsta.no osen.no osteroy.no osterøy.no " +
    "valer.ostfold.no våler.østfold.no ostre-toten.no østre-toten.no overhalla.no ovre-eiker.no " +
    "øvre-eiker.no oyer.no øyer.no oygarden.no øygarden.no oystre-slidre.no øystre-slidre.no porsanger.no " +
    "porsangu.no porsáŋgu.no porsgrunn.no rade.no råde.no radoy.no radøy.no rælingen.no rahkkeravju.no " +
    "ráhkkerávju.no raisa.no ráisa.no rakkestad.no ralingen.no rana.no randaberg.no rauma.no re.no " +
    "rendalen.no rennebu.no rennesoy.no rennesøy.no rindal.no ringebu.no ringerike.no ringsaker.no risor.no " +
    "risør.no rissa.no roan.no rodoy.no rødøy.no rollag.no romsa.no romskog.no rømskog.no roros.no røros.no " +
    "rost.no røst.no royken.no røyken.no royrvik.no røyrvik.no ruovat.no rygge.no salangen.no salat.no " +
    "sálat.no sálát.no saltdal.no samnanger.no sandefjord.no sandnes.no sandoy.no sandøy.no sarpsborg.no " +
    "sauda.no sauherad.no sel.no selbu.no selje.no seljord.no siellak.no sigdal.no siljan.no sirdal.no skanit.no " +
    "skánit.no skanland.no skånland.no skaun.no skedsmo.no ski.no skien.no skierva.no skiervá.no skiptvet.no " +
    "skjak.no skjåk.no skjervoy.no skjervøy.no skodje.no smola.no smøla.no snaase.no snåase.no snasa.no " +
    "snåsa.no snillfjord.no snoasa.no sogndal.no sogne.no søgne.no sokndal.no sola.no solund.no somna.no " +
    "sømna.no sondre-land.no søndre-land.no songdalen.no sor-aurdal.no sør-aurdal.no sor-fron.no sør-fron.no " +
    "sor-odal.no sør-odal.no sor-varanger.no sør-varanger.no sorfold.no sørfold.no sorreisa.no sørreisa.no " +
    "sortland.no sorum.no sørum.no spydeberg.no stange.no stavanger.no steigen.no steinkjer.no stjordal.no " +
    "stjørdal.no stokke.no stor-elvdal.no stord.no stordal.no storfjord.no strand.no stranda.no stryn.no " +
    "sula.no suldal.no sund.no sunndal.no surnadal.no sveio.no svelvik.no sykkylven.no tana.no bo.telemark.no " +
    "bø.telemark.no time.no tingvoll.no tinn.no tjeldsund.no tjome.no tjøme.no tokke.no tolga.no tonsberg.no " +
    "tønsberg.no torsken.no træna.no trana.no tranoy.no tranøy.no troandin.no trogstad.no trøgstad.no " +
    "tromsa.no tromso.no tromsø.no trondheim.no trysil.no tvedestrand.no tydal.no tynset.no tysfjord.no " +
    "tysnes.no tysvær.no tysvar.no ullensaker.no ullensvang.no ulstein.no ulvik.no unjarga.no unjárga.no " +
    "utsira.no vaapste.no vadso.no vadsø.no værøy.no vaga.no vågå.no vagan.no vågan.no vagsoy.no " +
    "vågsøy.no vaksdal.no valle.no vang.no vanylven.no vardo.no vardø.no varggat.no várggát.no varoy.no " +
    "vefsn.no vega.no vegarshei.no vegårshei.no vennesla.no verdal.no verran.no vestby.no sande.vestfold.no " +
    "vestnes.no vestre-slidre.no vestre-toten.no vestvagoy.no vestvågøy.no vevelstad.no vik.no vikna.no " +
    "vindafjord.no voagat.no volda.no voss.no *.np biz.nr com.nr edu.nr gov.nr info.nr net.nr org.nr ac.nz co.nz " +
    "cri.nz geek.nz gen.nz govt.nz health.nz iwi.nz kiwi.nz maori.nz māori.nz mil.nz net.nz org.nz " +
    "parliament.nz school.nz co.om com.om edu.om gov.om med.om museum.om net.om org.om pro.om abo.pa ac.pa " +
    "com.pa edu.pa gob.pa ing.pa med.pa net.pa nom.pa org.pa sld.pa com.pe edu.pe gob.pe mil.pe net.pe nom.pe " +
    "org.pe com.pf edu.pf org.pf *.pg com.ph edu.ph gov.ph i.ph mil.ph net.ph ngo.ph org.ph ac.pk biz.pk com.pk " +
    "edu.pk fam.pk gkp.pk gob.pk gog.pk gok.pk gop.pk gos.pk gov.pk net.pk org.pk web.pk com.pl net.pl org.pl " +
    "agro.pl aid.pl atm.pl auto.pl biz.pl edu.pl gmina.pl gsm.pl info.pl mail.pl media.pl miasta.pl mil.pl " +
    "nieruchomosci.pl nom.pl pc.pl powiat.pl priv.pl realestate.pl rel.pl sex.pl shop.pl sklep.pl sos.pl " +
    "szkola.pl targi.pl tm.pl tourism.pl travel.pl turystyka.pl gov.pl ap.gov.pl griw.gov.pl ic.gov.pl is.gov.pl " +
    "kmpsp.gov.pl konsulat.gov.pl kppsp.gov.pl kwp.gov.pl kwpsp.gov.pl mup.gov.pl mw.gov.pl oia.gov.pl " +
    "oirm.gov.pl oke.gov.pl oow.gov.pl oschr.gov.pl oum.gov.pl pa.gov.pl pinb.gov.pl piw.gov.pl po.gov.pl " +
    "pr.gov.pl psp.gov.pl psse.gov.pl pup.gov.pl rzgw.gov.pl sa.gov.pl sdn.gov.pl sko.gov.pl so.gov.pl sr.gov.pl " +
    "starostwo.gov.pl ug.gov.pl ugim.gov.pl um.gov.pl umig.gov.pl upow.gov.pl uppo.gov.pl us.gov.pl uw.gov.pl " +
    "uzs.gov.pl wif.gov.pl wiih.gov.pl winb.gov.pl wios.gov.pl witd.gov.pl wiw.gov.pl wkz.gov.pl wsa.gov.pl " +
    "wskr.gov.pl wsse.gov.pl wuoz.gov.pl wzmiuw.gov.pl zp.gov.pl zpisdn.gov.pl augustow.pl babia-gora.pl " +
    "bedzin.pl beskidy.pl bialowieza.pl bialystok.pl bielawa.pl bieszczady.pl boleslawiec.pl bydgoszcz.pl " +
    "bytom.pl cieszyn.pl czeladz.pl czest.pl dlugoleka.pl elblag.pl elk.pl glogow.pl gniezno.pl gorlice.pl " +
    "grajewo.pl ilawa.pl jaworzno.pl jelenia-gora.pl jgora.pl kalisz.pl karpacz.pl kartuzy.pl kaszuby.pl " +
    "katowice.pl kazimierz-dolny.pl kepno.pl ketrzyn.pl klodzko.pl kobierzyce.pl kolobrzeg.pl konin.pl " +
    "konskowola.pl kutno.pl lapy.pl lebork.pl legnica.pl lezajsk.pl limanowa.pl lomza.pl lowicz.pl lubin.pl " +
    "lukow.pl malbork.pl malopolska.pl mazowsze.pl mazury.pl mielec.pl mielno.pl mragowo.pl naklo.pl nowaruda.pl " +
    "nysa.pl olawa.pl olecko.pl olkusz.pl olsztyn.pl opoczno.pl opole.pl ostroda.pl ostroleka.pl ostrowiec.pl " +
    "ostrowwlkp.pl pila.pl pisz.pl podhale.pl podlasie.pl polkowice.pl pomorskie.pl pomorze.pl prochowice.pl " +
    "pruszkow.pl przeworsk.pl pulawy.pl radom.pl rawa-maz.pl rybnik.pl rzeszow.pl sanok.pl sejny.pl skoczow.pl " +
    "slask.pl slupsk.pl sosnowiec.pl stalowa-wola.pl starachowice.pl stargard.pl suwalki.pl swidnica.pl " +
    "swiebodzin.pl swinoujscie.pl szczecin.pl szczytno.pl tarnobrzeg.pl tgory.pl turek.pl tychy.pl ustka.pl " +
    "walbrzych.pl warmia.pl warszawa.pl waw.pl wegrow.pl wielun.pl wlocl.pl wloclawek.pl wodzislaw.pl wolomin.pl " +
    "wroclaw.pl zachpomor.pl zagan.pl zarow.pl zgora.pl zgorzelec.pl co.pn edu.pn gov.pn net.pn org.pn biz.pr " +
    "com.pr edu.pr gov.pr info.pr isla.pr name.pr net.pr org.pr pro.pr ac.pr est.pr prof.pr aaa.pro aca.pro " +
    "acct.pro avocat.pro bar.pro cpa.pro eng.pro jur.pro law.pro med.pro recht.pro com.ps edu.ps gov.ps net.ps " +
    "org.ps plo.ps sec.ps com.pt edu.pt gov.pt int.pt net.pt nome.pt org.pt publ.pt gov.pw com.py coop.py edu.py " +
    "gov.py mil.py net.py org.py com.qa edu.qa gov.qa mil.qa name.qa net.qa org.qa sch.qa asso.re com.re arts.ro " +
    "com.ro firm.ro info.ro nom.ro nt.ro org.ro rec.ro store.ro tm.ro www.ro ac.rs co.rs edu.rs gov.rs in.rs " +
    "org.rs ac.rw co.rw coop.rw gov.rw mil.rw net.rw org.rw com.sa edu.sa gov.sa med.sa net.sa org.sa pub.sa " +
    "sch.sa com.sb edu.sb gov.sb net.sb org.sb com.sc edu.sc gov.sc net.sc org.sc com.sd edu.sd gov.sd info.sd " +
    "med.sd net.sd org.sd tv.sd a.se ac.se b.se bd.se brand.se c.se d.se e.se f.se fh.se fhsk.se fhv.se g.se " +
    "h.se i.se k.se komforb.se kommunalforbund.se komvux.se l.se lanbib.se m.se n.se naturbruksgymn.se o.se " +
    "org.se p.se parti.se pp.se press.se r.se s.se t.se tm.se u.se w.se x.se y.se z.se com.sg edu.sg gov.sg " +
    "net.sg org.sg com.sh gov.sh mil.sh net.sh org.sh org.sk com.sl edu.sl gov.sl net.sl org.sl art.sn com.sn " +
    "edu.sn gouv.sn org.sn univ.sn com.so edu.so gov.so me.so net.so org.so biz.ss co.ss com.ss edu.ss gov.ss " +
    "me.ss net.ss org.ss sch.ss co.st com.st consulado.st edu.st embaixada.st mil.st net.st org.st principe.st " +
    "saotome.st store.st com.sv edu.sv gob.sv org.sv red.sv gov.sx com.sy edu.sy gov.sy mil.sy net.sy org.sy " +
    "ac.sz co.sz org.sz ac.th co.th go.th in.th mi.th net.th or.th biz.tj co.tj com.tj edu.tj go.tj gov.tj " +
    "int.tj mil.tj name.tj net.tj nic.tj org.tj test.tj web.tj gov.tl co.tm com.tm edu.tm gov.tm mil.tm net.tm " +
    "nom.tm org.tm com.tn ens.tn fin.tn gov.tn ind.tn info.tn intl.tn mincom.tn nat.tn net.tn org.tn perso.tn " +
    "tourism.tn com.to edu.to gov.to mil.to net.to org.to av.tr bbs.tr bel.tr biz.tr com.tr dr.tr edu.tr gen.tr " +
    "gov.tr info.tr k12.tr kep.tr mil.tr name.tr net.tr org.tr pol.tr tel.tr tsk.tr tv.tr web.tr nc.tr gov.nc.tr " +
    "biz.tt co.tt com.tt edu.tt gov.tt info.tt mil.tt name.tt net.tt org.tt pro.tt club.tw com.tw ebiz.tw edu.tw " +
    "game.tw gov.tw idv.tw mil.tw net.tw org.tw ac.tz co.tz go.tz hotel.tz info.tz me.tz mil.tz mobi.tz ne.tz " +
    "or.tz sc.tz tv.tz com.ua edu.ua gov.ua in.ua net.ua org.ua cherkassy.ua cherkasy.ua chernigov.ua " +
    "chernihiv.ua chernivtsi.ua chernovtsy.ua ck.ua cn.ua cr.ua crimea.ua cv.ua dn.ua dnepropetrovsk.ua " +
    "dnipropetrovsk.ua donetsk.ua dp.ua if.ua ivano-frankivsk.ua kh.ua kharkiv.ua kharkov.ua kherson.ua " +
    "khmelnitskiy.ua khmelnytskyi.ua kiev.ua kirovograd.ua km.ua kr.ua kropyvnytskyi.ua krym.ua ks.ua kv.ua " +
    "kyiv.ua lg.ua lt.ua lugansk.ua luhansk.ua lutsk.ua lv.ua lviv.ua mk.ua mykolaiv.ua nikolaev.ua od.ua " +
    "odesa.ua odessa.ua pl.ua poltava.ua rivne.ua rovno.ua rv.ua sb.ua sebastopol.ua sevastopol.ua sm.ua sumy.ua " +
    "te.ua ternopil.ua uz.ua uzhgorod.ua uzhhorod.ua vinnica.ua vinnytsia.ua vn.ua volyn.ua yalta.ua " +
    "zakarpattia.ua zaporizhzhe.ua zaporizhzhia.ua zhitomir.ua zhytomyr.ua zp.ua zt.ua ac.ug co.ug com.ug edu.ug " +
    "go.ug gov.ug mil.ug ne.ug or.ug org.ug sc.ug us.ug ac.uk co.uk gov.uk ltd.uk me.uk net.uk nhs.uk org.uk " +
    "plc.uk police.uk *.sch.uk dni.us isa.us nsn.us ak.us al.us ar.us as.us az.us ca.us co.us ct.us dc.us de.us " +
    "fl.us ga.us gu.us hi.us ia.us id.us il.us in.us ks.us ky.us la.us ma.us md.us me.us mi.us mn.us mo.us ms.us " +
    "mt.us nc.us nd.us ne.us nh.us nj.us nm.us nv.us ny.us oh.us ok.us or.us pa.us pr.us ri.us sc.us sd.us tn.us " +
    "tx.us ut.us va.us vi.us vt.us wa.us wi.us wv.us wy.us k12.ak.us k12.al.us k12.ar.us k12.as.us k12.az.us " +
    "k12.ca.us k12.co.us k12.ct.us k12.dc.us k12.fl.us k12.ga.us k12.gu.us k12.ia.us k12.id.us k12.il.us " +
    "k12.in.us k12.ks.us k12.ky.us k12.la.us k12.ma.us k12.md.us k12.me.us k12.mi.us k12.mn.us k12.mo.us " +
    "k12.ms.us k12.mt.us k12.nc.us k12.ne.us k12.nh.us k12.nj.us k12.nm.us k12.nv.us k12.ny.us k12.oh.us " +
    "k12.ok.us k12.or.us k12.pa.us k12.pr.us k12.sc.us k12.tn.us k12.tx.us k12.ut.us k12.va.us k12.vi.us " +
    "k12.vt.us k12.wa.us k12.wi.us cc.ak.us lib.ak.us cc.al.us lib.al.us cc.ar.us lib.ar.us cc.as.us lib.as.us " +
    "cc.az.us lib.az.us cc.ca.us lib.ca.us cc.co.us lib.co.us cc.ct.us lib.ct.us cc.dc.us lib.dc.us cc.de.us " +
    "cc.fl.us lib.fl.us cc.ga.us lib.ga.us cc.gu.us lib.gu.us cc.hi.us lib.hi.us cc.ia.us lib.ia.us cc.id.us " +
    "lib.id.us cc.il.us lib.il.us cc.in.us lib.in.us cc.ks.us lib.ks.us cc.ky.us lib.ky.us cc.la.us lib.la.us " +
    "cc.ma.us lib.ma.us cc.md.us lib.md.us cc.me.us lib.me.us cc.mi.us lib.mi.us cc.mn.us lib.mn.us cc.mo.us " +
    "lib.mo.us cc.ms.us cc.mt.us lib.mt.us cc.nc.us lib.nc.us cc.ne.us lib.ne.us cc.nh.us lib.nh.us cc.nj.us " +
    "lib.nj.us cc.nm.us lib.nm.us cc.nv.us lib.nv.us cc.ny.us lib.ny.us cc.oh.us lib.oh.us cc.ok.us lib.ok.us " +
    "cc.or.us lib.or.us cc.pa.us lib.pa.us cc.pr.us lib.pr.us cc.ri.us lib.ri.us cc.sc.us lib.sc.us cc.sd.us " +
    "lib.sd.us cc.tn.us lib.tn.us cc.tx.us lib.tx.us cc.ut.us lib.ut.us cc.va.us lib.va.us cc.vi.us lib.vi.us " +
    "cc.vt.us lib.vt.us cc.wa.us lib.wa.us cc.wi.us lib.wi.us cc.wv.us cc.wy.us k12.wy.us lib.wy.us " +
    "chtr.k12.ma.us paroch.k12.ma.us pvt.k12.ma.us ann-arbor.mi.us cog.mi.us dst.mi.us eaton.mi.us gen.mi.us " +
    "mus.mi.us tec.mi.us washtenaw.mi.us com.uy edu.uy gub.uy mil.uy net.uy org.uy co.uz com.uz net.uz org.uz " +
    "com.vc edu.vc gov.vc mil.vc net.vc org.vc arts.ve bib.ve co.ve com.ve e12.ve edu.ve emprende.ve firm.ve " +
    "gob.ve gov.ve ia.ve info.ve int.ve mil.ve net.ve nom.ve org.ve rar.ve rec.ve store.ve tec.ve web.ve edu.vg " +
    "co.vi com.vi k12.vi net.vi org.vi ac.vn ai.vn biz.vn com.vn edu.vn gov.vn health.vn id.vn info.vn int.vn " +
    "io.vn name.vn net.vn org.vn pro.vn angiang.vn bacgiang.vn backan.vn baclieu.vn bacninh.vn baria-vungtau.vn " +
    "bentre.vn binhdinh.vn binhduong.vn binhphuoc.vn binhthuan.vn camau.vn cantho.vn caobang.vn daklak.vn " +
    "daknong.vn danang.vn dienbien.vn dongnai.vn dongthap.vn gialai.vn hagiang.vn haiduong.vn haiphong.vn " +
    "hanam.vn hanoi.vn hatinh.vn haugiang.vn hoabinh.vn hue.vn hungyen.vn khanhhoa.vn kiengiang.vn kontum.vn " +
    "laichau.vn lamdong.vn langson.vn laocai.vn longan.vn namdinh.vn nghean.vn ninhbinh.vn ninhthuan.vn " +
    "phutho.vn phuyen.vn quangbinh.vn quangnam.vn quangngai.vn quangninh.vn quangtri.vn soctrang.vn sonla.vn " +
    "tayninh.vn thaibinh.vn thainguyen.vn thanhhoa.vn thanhphohochiminh.vn thuathienhue.vn tiengiang.vn " +
    "travinh.vn tuyenquang.vn vinhlong.vn vinhphuc.vn yenbai.vn com.vu edu.vu net.vu org.vu com.ws edu.ws gov.ws " +
    "net.ws org.ws 個人.香港 公司.香港 政府.香港 教育.香港 組織.香港 網絡.香港 " +
    "ак.срб обр.срб од.срб орг.срб пр.срб упр.срб ทหาร.ไทย " +
    "ธุรกิจ.ไทย เน็ต.ไทย รัฐบาล.ไทย ศึกษา.ไทย " +
    "องค์กร.ไทย com.ye edu.ye gov.ye mil.ye net.ye org.ye ac.za agric.za alt.za co.za edu.za " +
    "gov.za grondar.za law.za mil.za net.za ngo.za nic.za nis.za nom.za org.za school.za tm.za web.za ac.zm " +
    "biz.zm co.zm com.zm edu.zm gov.zm info.zm mil.zm net.zm org.zm sch.zm ac.zw co.zw gov.zw mil.zw org.zw " +    "").split(/\s+/).filter(Boolean));

  // ------------------------------------------------------------------ glyph fingerprints
  // 16x16 ink-coverage hash, packed as hex (256 bits -> 64 hex chars). "Ink" = alpha
  // coverage when the image is a transparent glyph (color/theme independent), else
  // luminance contrast vs the background. Bit=1 means foreground/ink, consistently — so a
  // light-on-dark keypad hashes the same as a dark-on-light one.
  const FP_SIZE = 24;   // 24x24 = 576 bits; resolves round digits (0/6/8/9) far better than 16
  const DIGITS10 = "0123456789".split("");

  // Baked reference set: the BoursoBank "sasmap" glyphs, fingerprinted through the whole-glyph
  // ink-bbox pipeline (fingerprintBitsFromImage) — regenerate them if that pipeline changes.
  // Other keypads are covered by the synthetic font templates (built lazily below) and the
  // learned per-origin cache.
  const REFERENCES = {
    boursobank: {
      "0": "007e0001ff8003ffc00781c00700e00e00700e00700c00701c00381c00381c00381c00381c00381c00381c00381c00380c00300e00700e00700700e00700e003c3c001ff8000ff00",
      "1": "000700000f00001f00003f00007f0000f70000e700000700000700000700000700000700000700000700000700000700000700000700000700000700000700000700000700000700",
      "2": "007e0000ff0000c180000180000180000180000300000700000e00001c0000380000f00000ff8000ff800000000000000000000000000c3c380c3e7c0e3ec01e3cc01f26cc333c7c",
      "3": "007e0000ff00018300000300000300000700003e00003f0000030000018000038001830000ff00007e000000000000000000000000001e1e781f3cf819bcf019bef81930c01f3ec0",
      "4": "000700000700000f00001b00001b0000330000730000e30000ffc000ffc00003000003000003000003000000000000000000000000000799900f9998081f980b9f980c9998079998",
      "5": "00ff0000ff0000c00000c00000c00000ff0000ff0000c18000018000018000818000c38000ff00003e00000000000000000000000000032cc0037cc00378c00378c00b6cc00e6cf0",
      "6": "003f00007f8000e10000c00000c00001de0001ff0001e18001c18000c18000c18000e180007f00003e0000000000000000000000000062243866767c7676467e7e467a6e467a667c",
      "7": "01ff0001ff00000300000600000600000e00000c00001c00001800003800003000003000006000004000000000000000000000000000f1e3cfb376c9f237cee2778383668d81e2cf",
      "8": "007e0000ff0000c38000c18000c30000e700007e0000ff0000c30001818001818000c38000ff00003e000000000000000000000000003e44880c44c80c44d80c44700c6c700c3c30",
      "9": "000000001e00007f0000618000c18000c18000e180007f80003e80000180000180006300007f00001e00000000000000000000000000b4d36ff471c3fc6186fcf08c68988f000000",
    },
    // Société Générale "clavier virtuel": all keys are baked into one server-rendered PNG
    // (img#img_clavier) with transparent <span class="btn-clavier"> hover overlays on top, so
    // each key is read as a cropped region of that shared sprite (see spriteRegionOf +
    // fingerprintBitsFromRegion). The digits render deterministically — the same digit is
    // pixel-identical across reshuffles/sessions — so these baked fingerprints match live keys
    // at Hamming distance ~0. Captured from the tight ink-bbox region pipeline on live SG.
    sg: {
      "0": "000000000000000000001c00007f0000ff8001ff8001e3c003c3c003c3c003c3c003c3c003c3c003c3c003c3c003c3c003c3c001e3c001ff8000ff00007e00000000000000000000",
      "1": "00000000000000000000fc0003fc0003fc0001fc00003c00003c00003c00003c00003c00003c00003c00003c00003c00003c00003c0003ffc003ffc003ffc0000000000000000000",
      "2": "000000000000000000003c0000ff0003ff8003ff800187800007c00007c0000780000780000f80001f00003f00007e0000fc0001ff8003ffc003ffc003ffc0000000000000000000",
      "3": "000000000000000000003c0001ff0003ff8003ff800187c00007c0000f80007f80007f00007f00007f80000fc00003c00003c003c7c003ffc003ff8000ff00000000000000000000",
      "4": "000000000000000000000f80003f80003f80007f80007f8000f78000f78001f78001e78003c78007ffe007ffe007ffe0000780000780000780000780000780000000000000000000",
      "5": "00000000000000000001ff8001ffc001ff8001e00001e00001e00001fe0001ff8001ff8001efc00003c00003c00003c00103c003c7c003ff8003ff8000fe00000000000000000000",
      "6": "000000000000000000000c00007f0000ff8001ff8001e30003c00003c80003ff0003ff0003ff8003ff8003c7c003c3c003c7c001e78001ff8000ff00007e00000000000000000000",
      "7": "00000000000001ff8007ffe007ffe003ffe00007c00007c0000f00000f00001e00001e00003e00003c00003c00003c00003c00003c00007c00007c00003800000000000000000000",
      "8": "000000000000000000001c0000ff0001ff8001ff8001c3c001c3c001f38001ff8000ff0000ff0001ff8001cfc003c3c003c3c003c3c003ffc001ff8000ff00000000000000000000",
      "9": "00000000000000000000380000fe0001ff8003ff8003c3c003c3c003c3c003c3c003e7c001ffc001ffc000ffc00003c00003c0018f8001ff8001ff0000fe00000000000000000000",
    },
  };
  const MATCH_MAX_DIST = 115;  // <= ~20% of 576 bits
  const MATCH_MARGIN   = 18;   // best digit must beat 2nd-best DIGIT by this many bits

  const hexToBits = (hex) => {
    const bits = new Uint8Array(hex.length * 4);
    for (let i = 0; i < hex.length; i++) {
      const nib = parseInt(hex[i], 16);
      bits[i * 4] = (nib >> 3) & 1;
      bits[i * 4 + 1] = (nib >> 2) & 1;
      bits[i * 4 + 2] = (nib >> 1) & 1;
      bits[i * 4 + 3] = nib & 1;
    }
    return bits;
  };
  const bitsToHex = (bits) => {
    let hex = "";
    for (let i = 0; i < bits.length; i += 4)
      hex += ((bits[i] << 3) | (bits[i + 1] << 2) | (bits[i + 2] << 1) | bits[i + 3]).toString(16);
    return hex;
  };
  const hamming = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++; return d; };

  // Reference bit arrays: baked + (lazily) synthetic font templates. Grouped nearest-by-digit.
  const REF_BITS = [];
  for (const [set, digits] of Object.entries(REFERENCES))
    for (const [digit, hex] of Object.entries(digits))
      REF_BITS.push({ set, digit, bits: hexToBits(hex) });

  // Hash an ink-sampling function over a tight, square, centred crop into an FP_SIZE×FP_SIZE
  // grid (box-averaged, engine-independent) and threshold by the mean. Shared by the whole-glyph
  // and sprite-region paths so both normalise to the same frame: a glyph that tightly fills its
  // own image (bank PNG fonts) and one centred with wide margins (synthetic font templates) crop
  // to the same box and hence compare correctly. Source pixels outside the crop count as
  // background (ink 0), padding the square frame.
  function hashInkBox(inkAt, w, h, minx, miny, maxx, maxy) {
    const cw = maxx - minx + 1, ch = maxy - miny + 1, side = Math.max(cw, ch);
    const ox0 = minx - (side - cw) / 2, oy0 = miny - (side - ch) / 2; // square frame top-left, glyph centred
    const N = FP_SIZE * FP_SIZE, ink = new Float64Array(N);
    for (let oy = 0; oy < FP_SIZE; oy++)
      for (let ox = 0; ox < FP_SIZE; ox++) {
        const x0 = ox0 + (ox / FP_SIZE) * side, x1 = ox0 + ((ox + 1) / FP_SIZE) * side;
        const y0 = oy0 + (oy / FP_SIZE) * side, y1 = oy0 + ((oy + 1) / FP_SIZE) * side;
        let s = 0, n = 0;
        for (let y = Math.floor(y0); y < Math.ceil(y1); y++)
          for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
            n++;
            if (x >= 0 && y >= 0 && x < w && y < h) s += inkAt(x, y);
          }
        ink[oy * FP_SIZE + ox] = n ? s / n : 0;
      }
    let sum = 0; for (let i = 0; i < N; i++) sum += ink[i];
    const mean = sum / N;
    const bits = new Uint8Array(N);
    for (let i = 0; i < N; i++) bits[i] = ink[i] > mean ? 1 : 0;
    return bits;
  }

  // Fingerprint a standalone glyph image (own <img>/<svg>/background-image). Rasterise at the
  // image's NATURAL size (no pre-scaling — deterministic across engines), pick an ink measure —
  // alpha for transparent glyphs (colour/theme-independent), else |luminance − corner background|
  // for opaque ones (e.g. Banque Populaire's opaque PNG digits) — then crop to the digit's tight
  // ink bbox and square/centre/hash it via hashInkBox. Normalising to the ink bbox rather than
  // scaling the whole frame is what lets a tightly-cropped bank glyph line up with the centred,
  // wide-margin synthetic font templates (a naive full-frame scale abstains on ~9/10 of them).
  function fingerprintBitsFromImage(img) {
    const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    if (!w || !h) return new Uint8Array(FP_SIZE * FP_SIZE);
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d");
    ctx.clearRect(0, 0, w, h);      // keep transparency so alpha survives
    ctx.drawImage(img, 0, 0);       // natural size, no scaling
    const d = ctx.getImageData(0, 0, w, h).data; // may throw if tainted
    const lum = (i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    let minA = 255, maxA = 0;
    for (let p = 3; p < d.length; p += 4) { const a = d[p]; if (a < minA) minA = a; if (a > maxA) maxA = a; }
    let inkAt;
    if (maxA - minA > 24) {
      // Transparent glyph: ink = alpha coverage (independent of digit color / page theme).
      inkAt = (x, y) => d[(y * w + x) * 4 + 3];
    } else {
      // Opaque image: ink = |luminance - background|, background estimated from the 4 corners.
      const corners = [0, (w - 1) * 4, (h - 1) * w * 4, ((h - 1) * w + (w - 1)) * 4];
      let bg = 0; for (const ci of corners) bg += lum(ci); bg /= corners.length;
      inkAt = (x, y) => Math.abs(lum((y * w + x) * 4) - bg);
    }
    // Tight ink bbox = pixels whose ink clears 35% of the glyph's peak ink.
    let maxInk = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = inkAt(x, y); if (v > maxInk) maxInk = v; }
    if (maxInk <= 0) return new Uint8Array(FP_SIZE * FP_SIZE);
    const thr = maxInk * 0.35;
    let minx = Infinity, miny = Infinity, maxx = -1, maxy = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++)
      if (inkAt(x, y) > thr) { if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y; }
    if (maxx < 0) return new Uint8Array(FP_SIZE * FP_SIZE);
    return hashInkBox(inkAt, w, h, minx, miny, maxx, maxy);
  }

  // Fingerprint a sub-region of a shared sprite image (e.g. SG's img#img_clavier, which packs
  // all keys into one server-rendered PNG). Unlike per-key glyphs, a key's region is mostly cell
  // border + whitespace with a small digit near the centre, so we can't just scale the whole
  // region — the border would dominate the hash and every key would look alike. Instead we find
  // the digit's tight ink bounding box (relative to the region's background luminance, so it is
  // theme-independent), square+centre it, then hash it exactly like a standalone glyph. Returns
  // null when the region carries too little ink to be a digit (a blank cell).
  function fingerprintBitsFromRegion(src, sx, sy, sw, sh) {
    sw = Math.max(1, Math.round(sw)); sh = Math.max(1, Math.round(sh));
    const c = document.createElement("canvas");
    c.width = sw; c.height = sh;
    const ctx = c.getContext("2d");
    // 1:1 copy of the region at the sprite's NATIVE resolution — no scaling, so the pixels are
    // a deterministic PNG decode, identical across browser engines. (Scaling with drawImage uses
    // engine-specific interpolation, which shifts the hash enough to flip look-alike digits like
    // 6/1 between Firefox and Chromium — so we resample ourselves, in JS, below.)
    ctx.drawImage(src, Math.round(sx), Math.round(sy), sw, sh, 0, 0, sw, sh); // may throw if tainted
    const d = ctx.getImageData(0, 0, sw, sh).data;
    const lum = (x, y) => { const i = (y * sw + x) * 4; return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; };
    // Work in the cell's central zone only. The inset must clear the cell's grid border/frame:
    // a small inset leaves border pixels near the edges, and whether they cross the ink
    // threshold depends on the engine's PNG decode — which flipped digits on edge cells between
    // Firefox and Chromium. The digit is small and centred, so a generous inset is safe.
    const inset = Math.max(2, Math.round(Math.min(sw, sh) * 0.16));
    // Background luminance = MEDIAN over the central zone (the digit is a minority, so the median
    // is the paper colour). Median, not a row average, so a gridline grazing one sampled row
    // can't corrupt it. ink = |lum - bg|, theme-independent.
    const vals = [];
    for (let y = inset; y < sh - inset; y++) for (let x = inset; x < sw - inset; x++) vals.push(lum(x, y));
    vals.sort((a, b) => a - b);
    const bg = vals.length ? vals[vals.length >> 1] : 255;
    let minx = Infinity, miny = Infinity, maxx = -1, maxy = -1, cnt = 0;
    for (let y = inset; y < sh - inset; y++)
      for (let x = inset; x < sw - inset; x++)
        if (Math.abs(lum(x, y) - bg) > 60) { cnt++; if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y; }
    if (cnt < Math.max(6, sw * sh * 0.004)) return null; // blank cell
    const pad = Math.max(1, Math.round(Math.min(sw, sh) * 0.05));
    minx = Math.max(0, minx - pad); miny = Math.max(0, miny - pad);
    maxx = Math.min(sw - 1, maxx + pad); maxy = Math.min(sh - 1, maxy + pad);
    // Box-average |lum - bg| over the square-framed crop into the FP_SIZE grid (same path as the
    // whole-glyph fingerprint, so region-read and image-read glyphs land in one comparable space).
    return hashInkBox((x, y) => Math.abs(lum(x, y) - bg), sw, sh, minx, miny, maxx, maxy);
  }

  const loadImage = (src) => new Promise((res, rej) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = src;
  });

  // Synthetic reference templates: digits 0-9 rendered in a spread of common fonts/weights,
  // hashed the same way as page glyphs. This lets us recognize font-rendered image keypads
  // we've never seen — no OCR, no dependencies, CSP-safe (self-contained data: URIs).
  const SYNTH_FONTS = ["Arial", "Helvetica", "Verdana", "Tahoma", "Trebuchet MS", "Georgia",
                       "Times New Roman", "Courier New", "Impact", "Arial Black", "Comic Sans MS", "cursive"];
  const SYNTH_WEIGHTS = [400, 700];
  const synthGlyphSrc = (ch, font, weight) =>
    "data:image/svg+xml;charset=utf-8," + encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">` +
      `<text x="50" y="54" font-family="${font}" font-size="82" font-weight="${weight}" fill="#000" ` +
      `text-anchor="middle" dominant-baseline="middle">${ch}</text></svg>`);
  let synthPromise = null;
  function ensureSynthRefs() {
    if (!synthPromise) synthPromise = (async () => {
      for (const font of SYNTH_FONTS)
        for (const weight of SYNTH_WEIGHTS)
          for (const digit of DIGITS10) {
            try {
              const img = await loadImage(synthGlyphSrc(digit, font, weight));
              REF_BITS.push({ set: `synth:${font}:${weight}`, digit, bits: fingerprintBitsFromImage(img) });
            } catch (e) {}
          }
    })();
    return synthPromise;
  }

  // Learned per-origin cache: hash -> digit. Populated on confident matches; checked first
  // so recognition is instant and stable across reshuffles/sessions (and can be cleared).
  const CACHE_KEY = "glyphCache:" + origin;
  const CACHE_MAX = 60;
  const CACHE_HIT_DIST = 8;
  let glyphCache = null;
  function loadCache() {
    if (!glyphCache) {
      const raw = store.get(CACHE_KEY, []);
      glyphCache = (Array.isArray(raw) ? raw : []).map((e) => ({ d: e.d, bits: hexToBits(e.h) }));
    }
    return glyphCache;
  }
  function cacheAdd(bits, digit) {
    const c = loadCache();
    c.push({ d: digit, bits });
    while (c.length > CACHE_MAX) c.shift();
    store.set(CACHE_KEY, c.map((e) => ({ h: bitsToHex(e.bits), d: e.d })));
  }
  function clearGlyphCache() { glyphCache = []; store.set(CACHE_KEY, []); }

  // Extract a rasterizable image source from a key element (img / bg-image / canvas / inline svg).
  function extractImageSource(el) {
    const img = el.querySelector("img");
    if (img && (img.currentSrc || img.src)) return img.currentSrc || img.src;
    const svg = el.querySelector("svg");
    if (svg) return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(new XMLSerializer().serializeToString(svg));
    const canvas = el.querySelector("canvas");
    if (canvas) { try { return canvas.toDataURL(); } catch (e) {} }
    for (const target of [el, el.querySelector("*")]) {
      if (!target) continue;
      const bg = getComputedStyle(target).backgroundImage;
      if (!bg || bg === "none") continue;
      // Quote-aware, and tolerant of ')' *inside* the URL — a data: URI can contain unescaped
      // parens (e.g. an SVG fill="hsl(...)"), which a non-greedy .*? up to the first ')' would
      // truncate into a broken URL. Prefer the quoted form; fall back to unquoted (no parens).
      const m = bg.match(/url\((["'])([\s\S]*)\1\)/) || bg.match(/url\(([^)]+)\)/);
      if (m) return m[m.length - 1];
    }
    return null;
  }

  // A key that carries no glyph of its own (no img/svg/canvas/bg-image) may be a transparent
  // overlay sitting on top of a shared sprite image that holds every key — the SG "clavier
  // virtuel" pattern (one img#img_clavier PNG, 16 <span> hover targets on top). Find the
  // smallest loaded <img> that fully contains this element and is several keys large, and
  // return the element's rectangle mapped into that image's natural pixels, so the reader can
  // crop just this key out of the sprite. Returns null when there is no such containing image.
  function spriteRegionOf(el) {
    const er = el.getBoundingClientRect();
    if (er.width < 1 || er.height < 1) return null;
    let best = null;
    for (const im of document.querySelectorAll("img")) {
      if (!im.naturalWidth) continue;
      const ir = im.getBoundingClientRect();
      const contains = ir.left <= er.left + 1 && ir.top <= er.top + 1 && ir.right >= er.right - 1 && ir.bottom >= er.bottom - 1;
      if (!contains) continue;
      if (ir.width * ir.height < er.width * er.height * 3) continue; // sprite must be several keys large
      const area = ir.width * ir.height;
      if (!best || area < best.area) best = { im, ir, area };
    }
    if (!best) return null;
    const { im, ir } = best;
    const scaleX = im.naturalWidth / ir.width, scaleY = im.naturalHeight / ir.height;
    return { img: im, sx: (er.left - ir.left) * scaleX, sy: (er.top - ir.top) * scaleY, sw: er.width * scaleX, sh: er.height * scaleY };
  }

  // Match a fingerprint against the learned cache and the reference templates. Returns a digit
  // string or null. Shared by every glyph source (own image or sprite region).
  async function matchGlyphBits(bits) {
    // 1. Learned cache: a near-exact hit wins immediately.
    let cHit = null;
    for (const e of loadCache()) { const dist = hamming(bits, e.bits); if (!cHit || dist < cHit.dist) cHit = { d: e.d, dist }; }
    if (cHit && cHit.dist <= CACHE_HIT_DIST) return cHit.d;
    // 2. Templates (baked + synthetic fonts): nearest DIGIT (min over that digit's
    //    templates), accepted only if it clears the max distance AND beats the 2nd-best
    //    *digit* by the margin — so multiple fonts of the same digit don't cancel each other.
    await ensureSynthRefs();
    const perDigit = {};
    for (const ref of REF_BITS) { const dist = hamming(bits, ref.bits); if (perDigit[ref.digit] == null || dist < perDigit[ref.digit]) perDigit[ref.digit] = dist; }
    let best = null, second = null;
    for (const digit in perDigit) {
      const dist = perDigit[digit];
      if (!best || dist < best.dist) { second = best; best = { digit, dist }; }
      else if (!second || dist < second.dist) { second = { digit, dist }; }
    }
    if (best && best.dist <= MATCH_MAX_DIST && (!second || second.dist - best.dist >= MATCH_MARGIN)) {
      cacheAdd(bits, best.digit);
      return best.digit;
    }
    return null;
  }

  async function readGlyphDigit(el) {
    // Prefer a glyph the element owns; otherwise fall back to cropping it out of a shared sprite.
    let bits = null;
    const src = extractImageSource(el);
    if (src) {
      try { bits = fingerprintBitsFromImage(await loadImage(src)); } catch (e) { bits = null; }
    }
    if (!bits) {
      const reg = spriteRegionOf(el);
      if (reg) { try { bits = fingerprintBitsFromRegion(reg.img, reg.sx, reg.sy, reg.sw, reg.sh); } catch (e) { bits = null; } }
    }
    if (!bits) return null;
    return matchGlyphBits(bits);
  }

  const singleDigit = (s) => { const m = (s || "").trim().match(/^\D*(\d)\D*$/); return m ? m[1] : null; };

  async function readDigit(el) {
    // 1. text
    let d = singleDigit(el.textContent);
    if (d) return { digit: d, method: "text" };
    // 2. attributes
    for (const attr of ["aria-label", "title", "alt", "value", "data-digit", "data-value", "data-key"]) {
      d = singleDigit(el.getAttribute && el.getAttribute(attr));
      if (d) return { digit: d, method: "attr:" + attr };
    }
    // 3. glyph
    d = await readGlyphDigit(el);
    if (d) return { digit: d, method: "glyph" };
    return null;
  }

  // ------------------------------------------------------------------ detector
  // Broad net of "clickable-ish" elements. Spatial clustering (below) does the real
  // discrimination, so this only needs to *contain* the keys, not pinpoint them.
  // Deliberately site-agnostic: a broad net of "clickable-ish" elements plus a few generic
  // data-attribute naming conventions. No per-site classes/ids — spatial clustering does the
  // real discrimination, and every keypad we've handled (BoursoBank <button>s, SG overlay
  // spans, LBP text buttons) is caught by these generic hints.
  const CANDIDATE_SELECTOR = [
    "button", "[role=button]", "a[href]", "[onclick]",
    "[data-key]", "[data-digit]", "[tabindex]",
  ].join(",");

  const DIGITS = "0123456789".split("");
  // Cap the whole-page fallback scan: glyph-reading hundreds of elements is expensive and
  // never needed on a real keypad page (the cluster path handles those).
  const FALLBACK_MAX_CANDS = 60;

  const isShown = (el) => {
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && parseFloat(s.opacity || "1") > 0.05;
  };
  // Keypad-key candidate: shown AND within the size band of a single key.
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 12 || r.height < 12 || r.width > 260 || r.height > 260) return false;
    return isShown(el);
  };

  const inOurUI = (el) => !!(el.closest && el.closest("#" + PANEL_ID + ",#" + OVERLAY_ID));

  function collectCandidates() {
    const set = new Set(document.querySelectorAll(CANDIDATE_SELECTOR));
    return [...set].filter((el) => !inOurUI(el) && visible(el));
  }

  // Group candidates into clusters of near-uniform size (the geometric signature of a
  // keypad: ~10-12 equally-sized keys). Returns clusters (arrays of elements) with >=10
  // members, largest first. Pure geometry — no digit reading, so it's cheap.
  function clusterByGeometry(els) {
    const items = els.map((el) => { const r = el.getBoundingClientRect(); return { el, w: r.width, h: r.height }; });
    const groups = [];
    for (const it of items) {
      const g = groups.find((g) =>
        Math.abs(g.w - it.w) <= Math.max(6, g.w * 0.2) &&
        Math.abs(g.h - it.h) <= Math.max(6, g.h * 0.2));
      if (g) { g.items.push(it); g.w = (g.w * (g.items.length - 1) + it.w) / g.items.length; g.h = (g.h * (g.items.length - 1) + it.h) / g.items.length; }
      else groups.push({ w: it.w, h: it.h, items: [it] });
    }
    return groups
      .filter((g) => g.items.length >= 10)
      .sort((a, b) => b.items.length - a.items.length)
      .map((g) => g.items.map((i) => i.el));
  }

  const digitsCovered = (byDigit) => DIGITS.filter((d) => byDigit[d]).length;
  const coversAllDigits = (byDigit) => digitsCovered(byDigit) === 10;

  // Read digits from a set of elements. Returns { keys:[{el,digit,method}], byDigit, covered }.
  async function readCluster(els) {
    const keys = [];
    for (const el of els) {
      const r = await readDigit(el);
      if (r) keys.push({ el, digit: r.digit, method: r.method });
    }
    const byDigit = {};
    for (const k of keys) byDigit[k.digit] = k.el; // last wins
    return { keys, byDigit, covered: digitsCovered(byDigit) };
  }

  // Find the current keypad. Prefers geometric clusters (scoped digit reads avoid stray
  // page digits mapping into byDigit); falls back to a bounded whole-page scan.
  // Returns the best result { keys, byDigit, covered, els } or null.
  async function findKeypad() {
    const cands = collectCandidates();
    let best = null;
    for (const cl of clusterByGeometry(cands)) {
      const res = await readCluster(cl);
      if (!best || res.covered > best.covered) best = { ...res, els: cl };
      if (res.covered === 10) return best;
    }
    if (!best || best.covered < 10) {
      if (cands.length <= FALLBACK_MAX_CANDS) {
        const res = await readCluster(cands);
        if (!best || res.covered > best.covered) best = { ...res, els: cands };
      } else {
        console.debug(`[KR] skipped whole-page fallback (${cands.length} candidates > ${FALLBACK_MAX_CANDS})`);
      }
    }
    return best;
  }

  const dominantMethod = (keys) => {
    const c = {};
    for (const k of keys) c[k.method] = (c[k.method] || 0) + 1;
    return Object.entries(c).sort((a, b) => b[1] - a[1]).map(([m]) => m)[0] || "?";
  };

  // ------------------------------------------------------------------ localizer (visual)
  // Locate the keypad purely from rendered layout — no digit recognition — so it works on
  // unknown/foreign keypads too. Recognition is layered on top afterwards.

  // Count distinct 1-D bands (rows or columns) among coordinate values within a tolerance.
  const bandCount = (vals, tol = 8) => {
    let n = 0, last = -Infinity;
    for (const v of [...vals].sort((a, b) => a - b)) { if (v - last > tol) { n++; last = v; } }
    return n;
  };

  const zoneOf = (rects) => {
    const left = Math.min(...rects.map((r) => r.left));
    const top = Math.min(...rects.map((r) => r.top));
    const right = Math.max(...rects.map((r) => r.right));
    const bottom = Math.max(...rects.map((r) => r.bottom));
    return { left, top, width: right - left, height: bottom - top };
  };

  // Among candidate clusters, pick the most keypad-like: a compact grid of >=2 rows and
  // columns whose cell count ≈ rows×cols. Falls back to the largest cluster.
  function bestKeypadCluster(clusters) {
    let best = null;
    for (const els of clusters) {
      const rects = els.map((el) => el.getBoundingClientRect());
      const rows = bandCount(rects.map((r) => r.top + r.height / 2));
      const cols = bandCount(rects.map((r) => r.left + r.width / 2));
      const gridish = rows >= 2 && cols >= 2;
      const full = Math.abs(rows * cols - els.length) <= 2;
      const score = els.length + (gridish ? 100 : 0) + (gridish && full ? 40 : 0);
      if (!best || score > best.score) best = { els, rects, rows, cols, score };
    }
    return best;
  }

  // Returns { els, cells:[rect], zone:rect, rows, cols } for the best keypad, or null.
  function localizeKeypad() {
    const best = bestKeypadCluster(clusterByGeometry(collectCandidates()));
    if (!best) return null;
    return { els: best.els, cells: best.rects, zone: zoneOf(best.rects), rows: best.rows, cols: best.cols };
  }

  // ------------------------------------------------------------------ click replay
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const jitter = (base, spread) => base + Math.floor(Math.random() * spread);
  const now = () => (window.performance && performance.now ? performance.now() : Date.now());

  // A generic "did that click register?" probe — no per-site knowledge, so no keypad ever
  // needs a hardcoded delay. An ACCEPTED keypress always makes the page do something we can
  // see; a DROPPED one (a debounced handler ignoring a too-fast tap) does nothing. We watch
  // two site-agnostic signals, in order of trust:
  //   1. ENTRY PROGRESS (authoritative) — keypads pipe accepted digits into a field, growing
  //      its value by one. We track the SUM OF POSITIVE LENGTH DELTAS across page inputs since
  //      the probe was created. Deltas (not absolute lengths) are essential: a pre-filled,
  //      often numeric username (SG's "Identifiant client") would otherwise dominate a max()
  //      and mask every increment. This counts only the field that is actually GROWING, and is
  //      format-independent (digits, bullets, anything). input.value writes are invisible to
  //      MutationObserver, so we read values directly.
  //   2. DOM churn (fallback) — a filled mask dot, a reshuffle, an aria-live update, over the
  //      whole document minus our own panel. Used ONLY until entry progress proves itself: a
  //      DROPPED tap can still fire churn (hover/active/focus class toggles), so once a real
  //      field is found, the caller locks onto (1) and ignores churn — otherwise a debounced
  //      keypad (SG) would read every dropped tap as accepted.
  // A site that exposes NEITHER is "unobservable"; the caller falls back to a blind fixed
  // cadence so we never regress correctness.
  function makeRegistrationProbe() {
    let mutations = 0;
    const obs = new MutationObserver((records) => {
      for (const rec of records) if (!inOurUI(rec.target)) { mutations++; return; }
    });
    obs.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    const len = (inp) => (inp.value || "").replace(/\s/g, "").length;
    // Baseline length per input at probe creation (i.e. before any code digit is typed).
    const base = new Map();
    for (const inp of document.querySelectorAll("input")) if (!inOurUI(inp)) base.set(inp, len(inp));
    const entryProgress = () => {
      let sum = 0;
      for (const inp of document.querySelectorAll("input")) {
        if (inOurUI(inp)) continue;
        const grew = len(inp) - (base.has(inp) ? base.get(inp) : 0);
        if (grew > 0) sum += grew;
      }
      return sum;
    };
    return {
      mutations: () => mutations,
      entryProgress,
      disconnect: () => obs.disconnect(),
    };
  }

  function dispatchRealClick(el) {
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    // Use document.defaultView (the real Window) — under a userscript sandbox the global
    // `window` is a proxy that the PointerEvent/MouseEvent constructors refuse as `view`.
    const view = document.defaultView || undefined;
    const base = { bubbles: true, cancelable: true, composed: true, clientX: cx, clientY: cy };
    if (view) base.view = view;
    const pointer = { ...base, pointerId: 1, pointerType: "mouse", isPrimary: true };
    el.dispatchEvent(new PointerEvent("pointerover", pointer));
    el.dispatchEvent(new PointerEvent("pointerenter", pointer));
    el.dispatchEvent(new PointerEvent("pointerdown", pointer));
    el.dispatchEvent(new MouseEvent("mousedown", base));
    if (el.focus) try { el.focus(); } catch (e) {}
    el.dispatchEvent(new PointerEvent("pointerup", pointer));
    el.dispatchEvent(new MouseEvent("mouseup", base));
    el.dispatchEvent(new MouseEvent("click", base));
  }

  // Type a secret by clicking mapped keys.
  //
  // SCAN ONCE. Real keypads do not reshuffle on every keypress (that would be a hostile UX),
  // so re-recognising the whole grid before each digit was pure waste — the dominant per-digit
  // cost on a real page, where reading ~16 glyphs off the live DOM is far from free. We map the
  // keypad a single time and reuse it, re-scanning only if a mapped key has actually left the
  // DOM (an SPA re-render or a rare timed reshuffle replaces its nodes → `isConnected` is false).
  //
  // Pacing is ADAPTIVE, not a fixed throttle: we type at full speed and confirm each click
  // actually registered (see makeRegistrationProbe). A well-behaved keypad accepts every tap
  // instantly — confirmation resolves on the next microtask, so `gap` stays 0 and there is no
  // artificial delay at all. Only when we catch a click being DROPPED — a debounced handler
  // (Société Générale) ignoring a too-fast tap — do we re-click that same key with a growing
  // gap, carried forward for the rest of the code. Discovery cost is paid ~once per run.
  async function typeSecret(secret, onStatus) {
    const status = onStatus || (() => {});
    const digits = String(secret).replace(/\D/g, "");
    if (!digits) { status("Nothing to type (no digits).", "bad"); return false; }

    const GAP_STEP = 120, GAP_MAX = 600;  // learned inter-key gap escalation (ms)
    const CONFIRM_MS = 250;               // how long to watch for a click to take effect
    const RETRY_MAX = 5;                  // per-digit re-clicks before giving up
    const probe = makeRegistrationProbe();
    let gap = 0;              // inter-key gap learned for THIS site during THIS run
    let observable = false;   // have we ever seen a click register via the probe?
    let entryMode = false;    // a real field has proven itself → trust ONLY entry progress
    let blind = false;        // site exposes no signal → assume taps land, use fixed cadence
    let kp = null;            // cached keypad mapping (scan once, reuse)

    // Return the click element for `digit`, (re)scanning only when we lack a live mapping for
    // it — i.e. first call, or the previously mapped key is gone (reshuffle/SPA re-render).
    const keyFor = async (digit, i) => {
      if (!kp || !kp.byDigit[digit] || !kp.byDigit[digit].isConnected) kp = await findKeypad();
      const el = kp && kp.byDigit[digit];
      if (!el) {
        const byDigit = (kp && kp.byDigit) || {};
        const have = DIGITS.filter((d) => byDigit[d]);
        const missing = DIGITS.filter((d) => !byDigit[d]);
        status(`Stuck at ${i}/${digits.length}: no key for "${digit}". Recognized ${have.length}/10 (missing ${missing.join("")}).`, "bad");
      }
      return el;
    };

    // Watch for the just-dispatched click to take effect. Entry progress (a real field growing)
    // is authoritative; DOM churn is a fallback used ONLY until a field proves itself, because a
    // dropped tap can still fire churn (see entryMode). MutationObserver callbacks and input
    // handlers both flush on the microtask queue, so an accepted tap is usually confirmed with
    // ZERO wall-clock delay; we only spin up to CONFIRM_MS when nothing happens (a dropped tap).
    // Returns "entry" | "churn" | null.
    const awaitRegistered = async (baseProgress, baseMut) => {
      const deadline = now() + CONFIRM_MS;
      for (;;) {
        await Promise.resolve();
        if (probe.entryProgress() > baseProgress) return "entry";
        if (!entryMode && probe.mutations() > baseMut) return "churn";
        if (now() >= deadline) return null;
        await sleep(4);
      }
    };

    try {
      for (let i = 0; i < digits.length; i++) {
        const el = await keyFor(digits[i], i);
        if (!el) return false;

        if (blind) {
          dispatchRealClick(el);
          status(`Typing… ${i + 1}/${digits.length}`, "");
          if (i < digits.length - 1) await sleep(jitter(260, 160));
          continue;
        }

        const digitBase = probe.entryProgress();  // field progress before this digit's first tap
        let registered = false;
        // We only ever RE-click a key once the site has proven itself observable. On a site
        // that accepts clicks yet exposes no signal, a retry would land twice and duplicate the
        // digit; once a click has been confirmed, "no signal" provably means "dropped".
        for (let attempt = 0; attempt <= RETRY_MAX && !registered; attempt++) {
          if (attempt > 0) {
            if (!observable) break;                 // unverifiable — don't risk a duplicate tap
            // Previous tap was dropped: grow the learned gap and space this retry out.
            gap = Math.min(GAP_MAX, (gap || GAP_STEP) + GAP_STEP);
            await sleep(gap);
            // A slow-but-accepted tap may have landed during the spin+back-off; if the field
            // already advanced past this digit's baseline, don't re-click (that would duplicate).
            if (probe.entryProgress() > digitBase) { registered = true; entryMode = true; observable = true; break; }
          }
          const baseProgress = probe.entryProgress(), baseMut = probe.mutations();
          dispatchRealClick(el);
          status(`Typing… ${i + 1}/${digits.length}`, "");
          const via = await awaitRegistered(baseProgress, baseMut);
          if (via) { registered = true; observable = true; if (via === "entry") entryMode = true; }
        }

        if (!registered) {
          if (!observable) {
            // Never any signal from this site — we can't tell an accepted tap from a dropped
            // one. Assume the tap landed (as the old code always did) and finish with the blind,
            // generous cadence. Latch `blind` so later digits skip the confirmation wait too.
            blind = true;
            if (i < digits.length - 1) await sleep(jitter(260, 160));
            continue;
          }
          status(`Stuck at ${i}/${digits.length}: keypad kept dropping "${digits[i]}".`, "bad");
          return false;
        }

        // Registered. Pre-space the NEXT click by whatever gap we've learned (0 = no throttle).
        if (gap && i < digits.length - 1) await sleep(jitter(gap, 80));
      }
      status(`Typed ${digits.length} digit(s).`, "ok");
      return true;
    } finally {
      probe.disconnect();
    }
  }

  // ------------------------------------------------------------------ input bridge (UI)
  const PANEL_ID = "kr-panel";
  let panelEl = null;

  function buildPanel() {
    if (document.getElementById(PANEL_ID)) return document.getElementById(PANEL_ID);
    const wrap = document.createElement("div");
    wrap.id = PANEL_ID;
    // NOTE: stay BELOW KeePassXC-browser's UI layer (2147483646). Its field-selection
    // overlays ("Choose Custom Login Fields"), fill popup and in-field icon are positioned
    // on top of our input; if our panel uses the max z-index they render behind it and can't
    // be clicked. 2147483000 still floats above any real page content.
    //
    // CRITICAL: every `all:initial` below is paired with `opacity:1`. `all:initial` isolates
    // our panel from the host page's CSS, but it also sets the INLINE `style.opacity` to the
    // string "initial". KeePassXC-browser's field-visibility check walks each field's ancestors
    // and runs Number(ancestor.style.opacity) against a 0.7–1 range; Number("initial") is NaN,
    // which it treats as "invisible", so it silently refuses to wire its autofill dropdown onto
    // any input nested under an `all:initial` element. Appending `opacity:1` makes the inline
    // value a valid number, restoring detection while keeping the CSS isolation. (Verified live
    // against KeePassXC-Browser 1.10.3 on the BoursoBank keypad page.)
    wrap.style.cssText = "all:initial;opacity:1;position:fixed;z-index:2147483000;right:16px;bottom:16px;font-family:system-ui,Arial,sans-serif;";
    // A lone visible password field is enough: once the panel is not hidden by the `all:initial`
    // opacity bug (see above), KeePassXC-browser builds a single-password combination and wires
    // its dropdown/icon onto it — no companion username field required (verified live on the
    // BoursoBank keypad page).
    // Full panel (top frame): titled card with a status line. Compact panel (in a sub-frame,
    // e.g. a bank keypad iframe): just the password input + a single emoji button — no title and
    // no status text, so it stays small and out of the embedded form's way. Both expose the same
    // #kr-input / #kr-type hooks so the manager wiring and typing logic are identical.
    // Build the panel via CSSOM (element.style), NOT inline `style="..."` attributes. Under a strict
    // Content-Security-Policy that omits 'unsafe-inline' from `style-src` (e.g. Hello bank / BNP send
    // `style-src 'nonce-…'`), the browser STRIPS style attributes parsed from innerHTML — the panel
    // then renders with UA defaults (transparent card, unstyled 16px button). CSSOM `.style` writes are
    // NOT governed by `style-src`, so styling each node this way survives the CSP. (The wrap div above
    // already sets its own style via .cssText for the same reason; this makes its children match.)
    const mkEl = (tag, css, props) => {
      const el = document.createElement(tag);
      if (css) el.style.cssText = css;
      if (props) Object.assign(el, props);
      return el;
    };
    const form = mkEl("form", COMPACT
      ? "all:initial;opacity:1;display:flex;align-items:center;gap:6px;background:#101828;padding:8px;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.35);font-family:system-ui,Arial,sans-serif"
      : "all:initial;opacity:1;display:block;background:#101828;color:#fff;padding:12px 14px;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.35);width:250px;font-family:system-ui,Arial,sans-serif");
    if (!COMPACT) {
      const header = mkEl("div", "all:initial;opacity:1;display:flex;justify-content:space-between;align-items:center;margin-bottom:8px");
      header.appendChild(mkEl("strong", "all:initial;opacity:1;font:600 13px system-ui,Arial;color:#fff", { textContent: "🔢 Keypad Recognizer" }));
      header.appendChild(mkEl("span", "all:initial;opacity:1;cursor:pointer;color:#9aa7b8;font:14px system-ui", { id: "kr-close", textContent: "✕" }));
      form.appendChild(header);
      form.appendChild(mkEl("input", "all:initial;opacity:1;box-sizing:border-box;display:block;width:100%;padding:8px;border-radius:6px;border:1px solid #33415a;background:#fff;color:#111;font:13px system-ui;margin-bottom:8px",
        { id: "kr-input", type: "password", name: "password", autocomplete: "current-password", placeholder: "Password manager fills here" }));
      form.appendChild(mkEl("button", "all:initial;opacity:1;box-sizing:border-box;display:block;width:100%;text-align:center;cursor:pointer;background:#2f6bff;color:#fff;font:600 13px system-ui;padding:9px;border-radius:6px",
        { id: "kr-type", type: "button", textContent: "Type on keypad" }));
      form.appendChild(mkEl("div", "all:initial;opacity:1;display:block;font:11px system-ui;color:#9aa7b8;margin-top:8px;min-height:14px", { id: "kr-status" }));
    } else {
      form.appendChild(mkEl("input", "all:initial;opacity:1;box-sizing:border-box;display:block;width:150px;padding:8px;border-radius:6px;border:1px solid #33415a;background:#fff;color:#111;font:13px system-ui",
        { id: "kr-input", type: "password", name: "password", autocomplete: "current-password", placeholder: "Code" }));
      form.appendChild(mkEl("button", "all:initial;opacity:1;box-sizing:border-box;display:block;cursor:pointer;background:#2f6bff;color:#fff;font:16px/1 system-ui;padding:9px 11px;border-radius:6px",
        { id: "kr-type", type: "button", title: "Type on keypad", textContent: PANEL_EMOJI }));
    }
    wrap.appendChild(form);
    (document.body || document.documentElement).appendChild(wrap);

    const setStatus = (msg, kind) => {
      const s = wrap.querySelector("#kr-status");
      if (!s) return; // compact panel has no status line
      s.textContent = msg;
      s.style.color = kind === "ok" ? "#4ade80" : kind === "bad" ? "#f87171" : "#9aa7b8";
    };
    const closeBtn = wrap.querySelector("#kr-close");
    if (closeBtn) closeBtn.addEventListener("click", () => wrap.remove());
    wrap.querySelector("#kr-type").addEventListener("click", async () => {
      const val = wrap.querySelector("#kr-input").value;
      await typeSecret(val, setStatus);
    });
    // Allow Enter in the field to trigger typing.
    wrap.querySelector("#kr-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); wrap.querySelector("#kr-type").click(); }
    });
    panelEl = wrap;
    setTypeEnabled(false); // disabled until a keypad is detected (see detectAndMaybeShow)
    return wrap;
  }

  // Enable "Type on keypad" only while a usable keypad (all 10 digits mapped) is detected.
  function setTypeEnabled(enabled) {
    const p = document.getElementById(PANEL_ID);
    const btn = p && p.querySelector("#kr-type");
    if (!btn) return;
    btn.disabled = !enabled;
    btn.style.opacity = enabled ? "1" : "0.45";
    btn.style.cursor = enabled ? "pointer" : "not-allowed";
    btn.title = enabled ? "" : "No keypad detected on this page yet.";
  }

  // Update the panel's status line to reflect the current detection (method + coverage).
  function reflectDetection(kp) {
    const p = document.getElementById(PANEL_ID);
    if (!p || !kp) return;
    const s = p.querySelector("#kr-status");
    if (s && !s.textContent) {
      s.textContent = `Keypad detected — ${kp.covered}/10 digits (${dominantMethod(kp.keys)}).`;
      s.style.color = "#9aa7b8";
    }
  }

  function showPanel() { const p = buildPanel(); p.style.display = ""; return p; }
  function hidePanel() { const p = document.getElementById(PANEL_ID); if (p) p.style.display = "none"; }

  // Keypad-aware placement (compact / in-frame only): drop the panel into the largest free margin
  // around the detected keypad so it never covers the keys. No-op in the top frame, where the full
  // panel keeps its fixed bottom-right corner.
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  function positionPanel(loc) {
    if (!COMPACT) return;
    const p = document.getElementById(PANEL_ID);
    if (!p || p.style.display === "none" || !loc || !loc.zone) return;
    const z = loc.zone;
    const vw = window.innerWidth, vh = window.innerHeight;
    const pr = p.getBoundingClientRect();
    const pw = pr.width || 210, ph = pr.height || 48;
    const M = 12; // gap from the keypad and the viewport edges
    let left, top;
    if (vh - (z.top + z.height) >= ph + M) {        // below the keypad
      top = z.top + z.height + M; left = clamp(z.left, M, vw - pw - M);
    } else if (z.top >= ph + M) {                   // above
      top = z.top - ph - M; left = clamp(z.left, M, vw - pw - M);
    } else if (vw - (z.left + z.width) >= pw + M) { // to the right
      left = z.left + z.width + M; top = clamp(z.top, M, vh - ph - M);
    } else if (z.left >= pw + M) {                  // to the left
      left = z.left - pw - M; top = clamp(z.top, M, vh - ph - M);
    } else {                                        // no clear gap — tuck into bottom-right
      left = vw - pw - M; top = vh - ph - M;
    }
    p.style.left = Math.round(left) + "px";
    p.style.top = Math.round(top) + "px";
    p.style.right = "auto";
    p.style.bottom = "auto";
  }

  // ------------------------------------------------------------------ debug overlay
  // Draws colored boxes over the detected keypad zone (cyan) and each digit cell
  // (green when recognized + labeled with the digit, pink "?" when only localized).
  // Purely diagnostic; pointer-events:none so it never intercepts clicks.
  const OVERLAY_ID = "kr-overlay";
  let overlayOn = store.get("overlay", false); // off by default; toggle from the KR menu
  let lastLoc = null, lastByDigit = null, overlayRAF = null;

  function ensureOverlay() {
    let ov = document.getElementById(OVERLAY_ID);
    if (!ov) {
      ov = document.createElement("div");
      ov.id = OVERLAY_ID;
      ov.style.cssText = "all:initial;position:fixed;left:0;top:0;width:0;height:0;z-index:2147483646;pointer-events:none";
      (document.body || document.documentElement).appendChild(ov);
    }
    return ov;
  }
  function overlayBox(color, x, y, w, h, label, labelPos) {
    const b = document.createElement("div");
    b.style.cssText = `all:initial;position:fixed;left:${x}px;top:${y}px;width:${w}px;height:${h}px;` +
      `border:2px solid ${color};box-sizing:border-box;pointer-events:none;border-radius:4px`;
    if (label != null) {
      const t = document.createElement("span");
      t.textContent = label;
      // Raise the zone label a full row above the cell labels so they never overlap.
      const top = labelPos === "zone" ? "-26px" : "-15px";
      t.style.cssText = `all:initial;position:absolute;left:-2px;top:${top};font:600 10px/1.4 system-ui,Arial;` +
        `color:#000;background:${color};padding:1px 4px;border-radius:3px;white-space:nowrap`;
      b.appendChild(t);
    }
    return b;
  }
  function clearOverlay() { const ov = document.getElementById(OVERLAY_ID); if (ov) ov.remove(); }
  // Draw from a localization result. When digits were recognized, box exactly those cells
  // (green + digit) — this is what "digit positions" means and it naturally excludes any
  // same-size non-key element (e.g. a submit button) that the size-cluster swept in. When
  // nothing is recognized, fall back to boxing the whole localized cluster (pink "?"), which
  // is the honest "found a keypad-shaped grid but can't read it" state. Zone + rows/cols are
  // recomputed from the drawn cells so the label is accurate either way.
  function drawOverlay(loc, byDigit) {
    lastLoc = loc; lastByDigit = byDigit || null;
    if (!overlayOn || !loc || !loc.els.length) { clearOverlay(); return; }
    const recognized = byDigit ? Object.entries(byDigit) : [];
    const cells = recognized.length
      ? recognized.map(([d, el]) => ({ el, label: d, color: "#a3e635" }))
      : loc.els.map((el) => ({ el, label: "?", color: "#f472b6" }));
    const rects = cells.map((c) => c.el.getBoundingClientRect()); // recompute (scroll/reshuffle-safe)
    const z = zoneOf(rects);
    const rows = bandCount(rects.map((r) => r.top + r.height / 2));
    const cols = bandCount(rects.map((r) => r.left + r.width / 2));
    const ov = ensureOverlay();
    ov.textContent = "";
    ov.appendChild(overlayBox("#22d3ee", z.left - 4, z.top - 4, z.width + 8, z.height + 8, `keypad zone ${rows}×${cols}`, "zone"));
    cells.forEach((c, i) => { const r = rects[i]; ov.appendChild(overlayBox(c.color, r.left, r.top, r.width, r.height, c.label)); });
  }
  // Cheap redraw on scroll/resize (positions only; reuses last localization).
  const refreshOverlay = () => {
    if (overlayRAF) return;
    overlayRAF = requestAnimationFrame(() => {
      overlayRAF = null;
      if (lastLoc) { drawOverlay(lastLoc, lastByDigit); positionPanel(lastLoc); }
    });
  };
  function toggleOverlay(on) {
    overlayOn = on == null ? !overlayOn : !!on;
    store.set("overlay", overlayOn);
    if (!overlayOn) clearOverlay(); else if (lastLoc) drawOverlay(lastLoc, lastByDigit);
    return overlayOn;
  }

  // ------------------------------------------------------------------ activation
  const panelVisible = () => { const p = document.getElementById(PANEL_ID); return !!p && p.style.display !== "none"; };

  // Cross-frame coordination (secret-free). When a bank serves its keypad in a cross-origin
  // iframe, the script runs in BOTH the top frame and the iframe, so without coordination the
  // top frame shows a dead, keypad-less panel next to the real (in-iframe) one. Fix: the frame
  // that actually finds a usable keypad tells the top frame ("a keypad lives down here" — no
  // secret), and the top frame hides its own eager panel. This is a POSITIVE signal only: with
  // no message, nothing changes, so single-frame sites (incl. BoursoBank, whose keypad is in the
  // top frame) behave exactly as before.
  const KR_MSG = "kr:keypad-here";
  let hasLocalKeypad = false;     // this frame currently has a keypad-shaped cluster
  let suppressedByChild = false;  // a descendant frame owns the keypad; keep our panel hidden
  let announcedKeypad = false;    // edge flag: announced this keypad's appearance already

  function announceKeypadToTop() {
    if (isTopFrame) return;
    try { if (window.top && window.top !== window) window.top.postMessage(KR_MSG, "*"); } catch (e) {}
  }
  function onFrameMessage(e) {
    if (e.data !== KR_MSG || hasLocalKeypad) return; // ignore if we own a keypad here
    // Only honor a descendant on our own registrable domain — an unrelated cross-domain iframe
    // must not be able to hide our panel. Fall back to exact-host equality for hosts with no
    // registrable domain (IPs, single-label like localhost), so two different such hosts don't match.
    let ok = false;
    try {
      const child = hostOf(e.origin), a = registrableDomain(child), b = registrableDomain(location.hostname);
      ok = a ? a === b : child === location.hostname;
    } catch (x) {}
    if (!ok) return;
    suppressedByChild = true;
    hidePanel();
  }

  let detecting = false;
  async function detectAndMaybeShow() {
    if (detecting) return false;
    detecting = true;
    try {
      // 1. Localize the keypad from layout (no recognition needed) so the debug overlay
      //    works even on keypads we can't yet read.
      const loc = localizeKeypad();
      if (!loc) {
        clearOverlay();
        setTypeEnabled(false); // no keypad in view -> nothing to type on
        hasLocalKeypad = false;
        announcedKeypad = false; // keypad gone — allow a fresh announce if it returns
        // Keep the panel (and its input) mounted even with no keypad in view, so a password
        // manager that has already wired its autofill onto the input doesn't lose it. Only
        // auto-hide when eager mount is disabled, or when a descendant frame owns the keypad
        // (this is the top frame of a keypad-in-iframe page). See start() for why we mount up-front.
        if ((!EAGER_PANEL || suppressedByChild) && panelVisible()) hidePanel();
        return false;
      }
      // A keypad-shaped cluster is present in THIS frame. Tell the top frame right away — before
      // (and independently of) digit recognition, which can lag behind async digit population and
      // is what made top-frame suppression feel slow. Edge-triggered so we ping once per
      // appearance, not on every re-detect. Localization alone is enough: the keypad lives here,
      // so the top frame's panel is dead regardless of whether we can yet read the digits.
      hasLocalKeypad = true;      // our own keypad wins over any child signal / incoming ping
      suppressedByChild = false;
      if (!announcedKeypad) { announceKeypadToTop(); announcedKeypad = true; }
      // 2. Recognize digits within the localized cells only (scoped + cheap).
      const kp = await readCluster(loc.els);
      // 3. Draw the overlay: zone + each cell, labeled with its recognized digit.
      drawOverlay(loc, kp.byDigit);
      const usable = coversAllDigits(kp.byDigit); // all 10 keys mapped -> typing can work
      setTypeEnabled(usable);
      if (usable) {
        showPanel();            // idempotent — normally already visible under EAGER_PANEL
        positionPanel(loc);     // keep the (compact) panel clear of the keys
        reflectDetection(kp);
        return true;
      }
      return false;
    } finally { detecting = false; }
  }

  let debounce = null;
  let observer = null;
  let lastDetect = 0;
  const onVisibility = () => scheduleDetect();
  // Leading-edge throttle (not a plain trailing debounce): run the first detection immediately so
  // a keypad already in the DOM — or arriving in the first mutation batch — is caught at once and
  // the top frame is told to hide its dead panel with minimal delay; then run at most once per
  // window. A trailing-only debounce could be starved for a long time by a stream of unrelated
  // mutations (spinners, iframe-resizer height messages, analytics), which is exactly what made
  // top-frame suppression feel slow.
  const DETECT_MS = 350;
  function scheduleDetect() {
    const since = Date.now() - lastDetect;
    clearTimeout(debounce); debounce = null;
    if (since >= DETECT_MS) {
      lastDetect = Date.now();
      detectAndMaybeShow();
    } else {
      debounce = setTimeout(() => { lastDetect = Date.now(); debounce = null; detectAndMaybeShow(); }, DETECT_MS - since);
    }
  }

  // Mount the panel up-front (at document-START) rather than only once a keypad is detected.
  // Password managers (e.g. KeePassXC) wire their autofill dropdown onto input fields only
  // during a *full* page scan — at load, on database unlock, or on manual "redetect" — and if
  // that first scan finds ZERO fields they retry only once (~2s) then give up (their
  // MutationObserver won't reliably wire fields added afterward). A field injected later
  // therefore misses the scan and never gets the inline menu (the fill keyboard shortcut still
  // works, since that re-queries on demand).
  //   The direct-to-keypad case makes this critical: when the bank remembers the account ID it
  // lands straight on the keypad page, whose ONLY login field is our #kr-input. Mounting at
  // document-idle raced (and lost) against that page's first scan. Running at document-start
  // and mounting the field the instant the script executes — before <body> exists — guarantees
  // it's in the DOM before the manager's initial scan, turning the race into a certainty.
  // Default ON: set kr:eagerPanel to false to restore show-on-detect behaviour.
  const EAGER_PANEL = store.get("eagerPanel", true);

  // At document-start there is usually no <body> yet; buildPanel() falls back to mounting on
  // <html>. Once the body exists, reparent into it so the DOM stays conventional (managers scan
  // the whole document, so the field is findable in either spot in the meantime).
  function reparentIntoBodyWhenReady() {
    if (document.body) return;
    document.addEventListener("DOMContentLoaded", () => {
      if (panelEl && document.body && panelEl.parentNode !== document.body) document.body.appendChild(panelEl);
    }, { once: true });
  }

  function start() {
    if (!isWhitelisted()) return;
    // Listen for a descendant frame claiming the keypad (see onFrameMessage). Installed before
    // the eager panel so a fast child signal is never missed.
    window.addEventListener("message", onFrameMessage);
    if (EAGER_PANEL && !suppressedByChild) { showPanel(); reparentIntoBodyWhenReady(); }
    scheduleDetect();
    // Ignore mutations we cause inside our own panel/overlay — otherwise the overlay redraw and
    // status/button updates below would self-trigger an endless detect loop (made worse now that we
    // also watch attribute changes).
    const isOwnUINode = (n) => {
      const e = n && (n.nodeType === 1 ? n : n.parentElement);
      return !!(e && e.closest && e.closest("#" + PANEL_ID + ",#" + OVERLAY_ID));
    };
    observer = new MutationObserver((records) => {
      if (records.every((r) => isOwnUINode(r.target))) return;
      scheduleDetect();
    });
    // childList catches keypads inserted into the DOM. But many multi-step bank forms (BNP /
    // Hello bank "cas", others) PRE-RENDER the keypad step hidden and REVEAL it by toggling a
    // class/style/hidden/aria-hidden — no node is inserted, so a childList-only observer never
    // re-detects (the keypad just sits there unrecognized). Watch those visibility-affecting
    // attributes too; scheduleDetect's 350ms leading-edge throttle bounds the extra churn.
    observer.observe(document.documentElement, {
      childList: true, subtree: true,
      attributes: true, attributeFilter: ["class", "style", "hidden", "aria-hidden", "disabled"],
    });
    // SPA route changes / tab restores often bring the keypad in/out without DOM mutations
    // the observer sees at document root — re-check on these too.
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pageshow", onVisibility);
    // Keep the debug overlay glued to the keypad as the page scrolls / resizes.
    window.addEventListener("scroll", refreshOverlay, true);
    window.addEventListener("resize", refreshOverlay);
  }

  function teardown() {
    clearTimeout(debounce);
    if (observer) { observer.disconnect(); observer = null; }
    window.removeEventListener("message", onFrameMessage);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pageshow", onVisibility);
    window.removeEventListener("scroll", refreshOverlay, true);
    window.removeEventListener("resize", refreshOverlay);
    clearOverlay();
    const p = document.getElementById(PANEL_ID);
    if (p) p.remove();
    panelEl = null;
  }

  // ------------------------------------------------------------------ menu commands
  // Under the dev hot-reload loader the IIFE re-runs every ~1.5s; naive registration
  // stacks duplicate menu entries. Unregister the previous batch first where supported,
  // otherwise register only once per page (stashing state on window across re-evals).
  function registerMenu() {
    if (typeof GM_registerMenuCommand === "undefined") return;
    const prev = window.__KR_MENU_IDS__;
    if (typeof GM_unregisterMenuCommand !== "undefined" && Array.isArray(prev)) {
      for (const id of prev) { try { GM_unregisterMenuCommand(id); } catch (e) {} }
    } else if (prev) {
      return; // can't unregister and already registered — leave the existing (working) batch.
    }
    const commands = [
      ["KR: Enable on this site", () => {
        const wl = getWhitelist(); if (!wl.includes(origin)) { wl.push(origin); store.set("whitelist", wl); }
        alert("Keypad Recognizer enabled on " + origin + "\nReload the page.");
      }],
      ["KR: Disable on this site", () => {
        store.set("whitelist", getWhitelist().filter((o) => o !== origin));
        alert("Keypad Recognizer disabled on " + origin + "\nReload the page.");
      }],
      ["KR: Show enabled sites", () => {
        const wl = getWhitelist();
        const force = store.get("forceEnable", false);
        const lines = [];
        if (force) lines.push("forceEnable is ON — active on ALL sites.");
        lines.push(wl.length ? "Enabled sites:\n" + wl.join("\n") : "No sites in the whitelist.");
        alert(lines.join("\n\n"));
      }],
      ["KR: Show panel now", () => showPanel()],
      ["KR: Detect keypad now", () => detectAndMaybeShow()],
      ["KR: Toggle detection overlay", () => toggleOverlay()],
      ["KR: Clear glyph cache (this site)", () => { clearGlyphCache(); alert("Glyph cache cleared for " + origin); }],
    ];
    window.__KR_MENU_IDS__ = commands.map(([name, fn]) => GM_registerMenuCommand(name, fn));
  }
  // Without @noframes the script now runs in every frame. Register menu commands only in the
  // top frame (where "Enable on this site" is needed before whitelisting) or in frames already
  // active, so arbitrary sub-frames don't each add a duplicate batch of commands.
  if (isTopFrame || isWhitelisted()) registerMenu();

  // ------------------------------------------------------------------ test hooks
  window.__KR__ = { detectAndMaybeShow, findKeypad, localizeKeypad, dominantMethod, drawOverlay, toggleOverlay, typeSecret, showPanel, hidePanel, clearGlyphCache, cacheAdd, store, isWhitelisted, registrableDomain, domainWhitelisted, REFERENCES, fingerprintBitsFromRegion, spriteRegionOf, __teardown: teardown };

  start();
})();
